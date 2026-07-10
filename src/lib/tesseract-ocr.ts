// Browser-only Tesseract.js OCR — one worker, reused across scans.
import { createWorker, PSM, type Worker } from "tesseract.js";

export type TileOcr = {
  index: number;
  letter: string;
  confidence: number; // 0..1
  attempt: "primary" | "inverted";
  rawText?: string;
  error?: string;
};

let workerPromise: Promise<Worker> | null = null;

export function getOcrWorker(): Promise<Worker> {
  if (workerPromise) return workerPromise;
  workerPromise = (async () => {
    const w = await createWorker("eng");
    await w.setParameters({
      tessedit_pageseg_mode: PSM.SINGLE_CHAR,
      tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    });
    return w;
  })();
  return workerPromise;
}

async function recognizeTile(worker: Worker, dataUrl: string): Promise<{ letter: string; conf: number; raw: string }> {
  const { data } = await worker.recognize(dataUrl);
  const raw = (data.text || "").toUpperCase().replace(/[^A-Z]/g, "");
  const letter = raw.slice(0, 1);
  const conf = Math.max(0, Math.min(1, (data.confidence ?? 0) / 100));
  return { letter, conf, raw };
}

// Invert a base64 PNG on canvas for retry.
async function invertDataUrl(dataUrl: string): Promise<string> {
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const el = new Image();
    el.onload = () => res(el);
    el.onerror = () => rej(new Error("invert: could not load tile"));
    el.src = dataUrl;
  });
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height);
  const px = d.data;
  for (let i = 0; i < px.length; i += 4) {
    px[i] = 255 - px[i];
    px[i + 1] = 255 - px[i + 1];
    px[i + 2] = 255 - px[i + 2];
  }
  ctx.putImageData(d, 0, 0);
  return c.toDataURL("image/png");
}

export async function ocrTiles(tiles: string[]): Promise<{ rows: string[][]; letters: string[]; tiles: TileOcr[] }> {
  const worker = await getOcrWorker();
  const results: TileOcr[] = [];
  // Sequential — a single worker isn't threadsafe for parallel recognize calls.
  for (let i = 0; i < tiles.length; i++) {
    try {
      const primary = await recognizeTile(worker, tiles[i]);
      if (primary.letter && primary.conf >= 0.35) {
        results.push({ index: i, letter: primary.letter, confidence: primary.conf, attempt: "primary", rawText: primary.raw });
        continue;
      }
      // Retry inverted
      const inv = await invertDataUrl(tiles[i]);
      const alt = await recognizeTile(worker, inv);
      if (alt.letter && (alt.conf >= primary.conf || !primary.letter)) {
        results.push({ index: i, letter: alt.letter, confidence: alt.conf, attempt: "inverted", rawText: alt.raw });
      } else {
        results.push({
          index: i,
          letter: primary.letter,
          confidence: primary.conf,
          attempt: "primary",
          rawText: primary.raw,
          error: primary.letter ? undefined : "no chars detected",
        });
      }
    } catch (err: any) {
      results.push({ index: i, letter: "", confidence: 0, attempt: "primary", error: err?.message ?? String(err) });
    }
  }
  const letters = results.map((r) => r.letter || "");
  const rows: string[][] = [0, 1, 2, 3].map((r) => letters.slice(r * 4, r * 4 + 4).map((l) => l || "?"));
  return { rows, letters, tiles: results };
}
