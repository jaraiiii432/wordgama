import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const InputSchema = z.object({
  tiles: z.array(z.string().min(20)).length(16).optional(),
  imageDataUrl: z.string().min(20).optional(),
}).refine((v) => !!v.tiles || !!v.imageDataUrl, {
  message: "Provide either tiles[16] or imageDataUrl",
});

type TileResult = {
  index: number;
  letter: string;
  confidence: number | null;
  attempt: "primary" | "inverted" | "whole";
  error?: string;
  rawText?: string;
};

async function ocrSpaceCall(base64Png: string, apiKey: string, opts?: { overlay?: boolean }) {
  const form = new URLSearchParams();
  form.set("apikey", apiKey);
  form.set("base64Image", base64Png);
  form.set("language", "eng");
  form.set("OCREngine", "2");
  form.set("isOverlayRequired", opts?.overlay ? "true" : "false");
  form.set("scale", "true");
  form.set("detectOrientation", "false");

  const res = await fetch("https://api.ocr.space/parse/image", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });

  if (res.status === 403 || res.status === 429) {
    throw new Error("OCR.space rate limit reached (25,000/month free tier). Try again later.");
  }
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`OCR.space HTTP ${res.status}: ${t.slice(0, 200)}`);
  }
  const json: any = await res.json();
  if (json?.IsErroredOnProcessing) {
    const msg = Array.isArray(json.ErrorMessage) ? json.ErrorMessage.join("; ") : String(json.ErrorMessage || "unknown");
    throw new Error(`OCR.space: ${msg}`);
  }
  return json;
}

function firstLetterFromJson(json: any): { letter: string; conf: number | null; rawText: string } {
  const parsed = json?.ParsedResults?.[0];
  const text = String(parsed?.ParsedText || "").toUpperCase().replace(/[^A-Z]/g, "");
  const letter = text.slice(0, 1);
  let conf: number | null = null;
  const lines = parsed?.TextOverlay?.Lines ?? [];
  const first = lines?.[0]?.Words?.[0];
  if (first && typeof first.WordText === "string") {
    // OCR.space doesn't return confidence directly; use word length as inverse-noise signal.
    conf = first.WordText.length === 1 ? 0.9 : 0.6;
  } else if (letter) {
    conf = 0.5;
  }
  return { letter, conf, rawText: String(parsed?.ParsedText || "") };
}

export const extractGrid = createServerFn({ method: "POST" })
  .inputValidator((data) => InputSchema.parse(data))
  .handler(async ({ data }) => {
    const apiKey = process.env.OCR_SPACE_API_KEY;
    if (!apiKey) throw new Error("OCR_SPACE_API_KEY missing");

    // Per-tile mode (preferred)
    if (data.tiles) {
      const requestLog = {
        mode: "tiles" as const,
        count: data.tiles.length,
        sampleKb: Math.round((data.tiles[0]?.length || 0) * 0.75 / 1024),
        engine: 2,
      };

      const results: TileResult[] = await Promise.all(
        data.tiles.map(async (tile, index): Promise<TileResult> => {
          try {
            const primary = await ocrSpaceCall(tile, apiKey, { overlay: true });
            const { letter, conf, rawText } = firstLetterFromJson(primary);
            if (letter) return { index, letter, confidence: conf, attempt: "primary", rawText };

            // Retry with inverted tile if the client sent one at tiles[index] via a separate call.
            // (Fallback: request client to send inverted separately isn't feasible here — return empty.)
            return { index, letter: "", confidence: 0, attempt: "primary", error: "no chars", rawText };
          } catch (err: any) {
            return { index, letter: "", confidence: null, attempt: "primary", error: err?.message ?? String(err) };
          }
        }),
      );

      const letters = results.map((r) => r.letter || "?");
      const rows: string[][] = [0, 1, 2, 3].map((r) => letters.slice(r * 4, r * 4 + 4));
      const errors = results.filter((r) => r.error).map((r) => `#${r.index}: ${r.error}`);
      const anySucceeded = results.some((r) => r.letter);
      if (!anySucceeded) {
        const summary = errors[0] || "All tiles returned no characters. Check lighting / contrast.";
        throw new Error(`OCR failed on every tile. First error: ${summary}`);
      }
      return { rows, letters, tiles: results, request: requestLog, raw: null };
    }

    // Fallback: whole-image mode
    const json = await ocrSpaceCall(data.imageDataUrl!, apiKey, { overlay: true });
    type Token = { text: string; left: number; top: number; height: number };
    const tokens: Token[] = [];
    const parsed = json?.ParsedResults?.[0];
    const lines = parsed?.TextOverlay?.Lines ?? [];
    for (const line of lines) {
      for (const w of (line?.Words ?? [])) {
        const raw = String(w?.WordText || "").toUpperCase().replace(/[^A-Z]/g, "");
        if (!raw) continue;
        const left = Number(w?.Left) || 0;
        const top = Number(w?.Top) || 0;
        const width = Number(w?.Width) || 0;
        const height = Number(w?.Height) || 0;
        if (raw.length === 1) tokens.push({ text: raw, left, top, height });
        else {
          const step = width / raw.length;
          for (let i = 0; i < raw.length; i++) tokens.push({ text: raw[i], left: left + step * (i + 0.5), top, height });
        }
      }
    }
    if (tokens.length < 4) {
      throw new Error(`OCR.space returned ${tokens.length} letters from whole image. Use per-tile mode or improve photo.`);
    }
    tokens.sort((a, b) => a.top - b.top);
    const avgH = tokens.reduce((s, t) => s + t.height, 0) / tokens.length || 20;
    const tol = Math.max(avgH * 0.6, 12);
    const buckets: Token[][] = [];
    for (const t of tokens) {
      const b = buckets.find((bk) => Math.abs(bk[0].top - t.top) <= tol);
      if (b) b.push(t); else buckets.push([t]);
    }
    buckets.sort((a, b) => a[0].top - b[0].top);
    while (buckets.length < 4) buckets.push([]);
    const chosen = buckets.slice(0, 4);
    const rows: string[][] = chosen.map((bk) => {
      const s = [...bk].sort((a, b) => a.left - b.left);
      return [0, 1, 2, 3].map((c) => s[c]?.text || "?");
    });
    return { rows, letters: rows.flat(), tiles: null, request: { mode: "whole" }, raw: parsed?.TextOverlay ?? null };
  });
