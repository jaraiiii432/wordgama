import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const InputSchema = z.object({
  imageDataUrl: z.string().min(20),
});

/**
 * OCR via OCR.space. Uses OCREngine=2 with isOverlayRequired=true, then
 * sorts detected characters/words by Top (row) then Left (column) coordinates
 * to build a spatial 4x4 grid.
 *
 * Response: { rows: string[][], letters: string[], raw?: any }
 */
export const extractGrid = createServerFn({ method: "POST" })
  .inputValidator((data) => InputSchema.parse(data))
  .handler(async ({ data }) => {
    const apiKey = process.env.OCR_SPACE_API_KEY;
    if (!apiKey) throw new Error("OCR_SPACE_API_KEY missing");

    const form = new URLSearchParams();
    form.set("apikey", apiKey);
    form.set("base64Image", data.imageDataUrl);
    form.set("language", "eng");
    form.set("OCREngine", "2");
    form.set("isOverlayRequired", "true");
    form.set("scale", "true");
    form.set("detectOrientation", "true");

    const res = await fetch("https://api.ocr.space/parse/image", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });

    if (res.status === 403 || res.status === 429) {
      throw new Error("OCR.space rate limit reached (free tier: 25,000/month). Please try again later.");
    }
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`OCR.space ${res.status}: ${t.slice(0, 200)}`);
    }

    const json: any = await res.json();
    if (json?.IsErroredOnProcessing) {
      const msg = Array.isArray(json.ErrorMessage) ? json.ErrorMessage.join("; ") : String(json.ErrorMessage || "unknown");
      throw new Error(`OCR.space error: ${msg}`);
    }

    // Collect every word/token with its position.
    type Token = { text: string; left: number; top: number; height: number };
    const tokens: Token[] = [];
    const parsed = json?.ParsedResults?.[0];
    const lines = parsed?.TextOverlay?.Lines ?? [];
    for (const line of lines) {
      for (const w of (line?.Words ?? [])) {
        const raw = String(w?.WordText || "").toUpperCase().replace(/[^A-Z]/g, "");
        if (!raw) continue;
        // OCR.space returns whole words; a "word" of >1 letter in a boggle grid
        // typically means adjacent letters bled together. Distribute them by width.
        const left = Number(w?.Left) || 0;
        const top = Number(w?.Top) || 0;
        const width = Number(w?.Width) || 0;
        const height = Number(w?.Height) || 0;
        if (raw.length === 1) {
          tokens.push({ text: raw, left, top, height });
        } else {
          const step = width / raw.length;
          for (let i = 0; i < raw.length; i++) {
            tokens.push({ text: raw[i], left: left + step * (i + 0.5), top, height });
          }
        }
      }
    }

    if (tokens.length < 4) {
      throw new Error(`OCR.space returned too few letters (${tokens.length}). Try a clearer photo.`);
    }

    // Cluster by Top into 4 rows.
    tokens.sort((a, b) => a.top - b.top);
    const avgH = tokens.reduce((s, t) => s + t.height, 0) / tokens.length || 20;
    const rowTolerance = Math.max(avgH * 0.6, 12);
    const rowBuckets: Token[][] = [];
    for (const t of tokens) {
      const bucket = rowBuckets.find((b) => Math.abs(b[0].top - t.top) <= rowTolerance);
      if (bucket) bucket.push(t);
      else rowBuckets.push([t]);
    }
    // Sort buckets top-to-bottom, keep 4 largest if extras, pad if fewer.
    rowBuckets.sort((a, b) => a[0].top - b[0].top);
    while (rowBuckets.length < 4) rowBuckets.push([]);
    const chosenRows = rowBuckets.slice(0, 4);

    // Within each row, sort by Left and take 4 evenly-spaced columns.
    const rows: string[][] = chosenRows.map((bucket) => {
      const sorted = [...bucket].sort((a, b) => a.left - b.left);
      const out: string[] = [];
      for (let c = 0; c < 4; c++) out.push(sorted[c]?.text || "?");
      return out;
    });

    const letters: string[] = rows.flat();
    return { rows, letters, raw: parsed?.TextOverlay ?? null };
  });
