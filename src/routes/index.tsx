import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { ocrTiles } from "@/lib/tesseract-ocr";
import { filterValidPaths, loadTrie, solve, type DictionaryTrie, type Path } from "@/lib/solver";
import { Upload, Loader2, Shuffle, Sparkles, Camera, Wand2, Eraser, Radio, StopCircle, RefreshCw, Settings } from "lucide-react";
import onlineNowAsset from "@/assets/online-now.gif.asset.json";
import skullsBgAsset from "@/assets/skulls-bg.jpg.asset.json";

export const Route = createFileRoute("/")({
  component: WordAssistant,
  head: () => ({
    meta: [
      { title: "Grid Word Assistant — Solve 4x4 word puzzles" },
      {
        name: "description",
        content:
          "Solve any 4x4 word-hunt grid. Type letters or upload a photo of your board and instantly find every valid English word.",
      },
      { property: "og:title", content: "Grid Word Assistant" },
      {
        property: "og:description",
        content: "Type or photograph a 4x4 grid and get every valid word.",
      },
    ],
  }),
});

const DEFAULT_GRID = "TRIESONALPHABET".padEnd(16, "S").slice(0, 16).split("");
const EMPTY_GRID = Array(16).fill("");
const DISPLAY_LIMIT = 50;
const TRACE_DELAY_MS = 3500;
const SETTINGS_KEY = "gwa.syncSettings.v1";
type SyncSettings = { scanIntervalMs: number; debounceMs: number };
const DEFAULT_SETTINGS: SyncSettings = { scanIntervalMs: 2500, debounceMs: 10 };
function loadSettings(): SyncSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const p = JSON.parse(raw);
    return {
      scanIntervalMs: Math.min(5000, Math.max(1000, Number(p.scanIntervalMs) || DEFAULT_SETTINGS.scanIntervalMs)),
      debounceMs: Math.min(200, Math.max(0, Number(p.debounceMs) || DEFAULT_SETTINGS.debounceMs)),
    };
  } catch { return DEFAULT_SETTINGS; }
}

const APP_BADGE_NAME = "Grid Word Assistant";

function randomGrid(): string[] {
  const dice = "AAAAAABBCCDDEEEEEEFFGGHHIIIIJKLLMMNNNNOOOOPPQRRRSSSSTTTTUUVVWWXYYZ";
  return Array.from({ length: 16 }, () => dice[Math.floor(Math.random() * dice.length)]);
}

type GridId = "manual" | "scanned";
type TraceState = { gridId: GridId; path: Path; step: number; locked: boolean };

async function fileToJpegDataUrl(file: File, maxDim = 512): Promise<string> {
  if (!file) throw new Error("No file selected");
  if (file.size === 0) throw new Error("File is empty (0 bytes) — the camera capture failed. Try again.");
  if (file.size > 25 * 1024 * 1024) throw new Error(`File is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max 25 MB.`);

  const name = (file.name || "").toLowerCase();
  const type = (file.type || "").toLowerCase();
  const isHeic = /heic|heif/.test(type) || /\.(heic|heif)$/.test(name);

  async function drawToJpeg(source: CanvasImageSource, w: number, h: number): Promise<string> {
    const scale = Math.min(1, maxDim / Math.max(w, h));
    const dw = Math.max(1, Math.round(w * scale));
    const dh = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement("canvas");
    canvas.width = dw;
    canvas.height = dh;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");
    ctx.drawImage(source, 0, 0, dw, dh);
    const url = canvas.toDataURL("image/jpeg", 0.8);
    if (!url || url.length < 100) throw new Error("Canvas produced an empty JPEG");
    return url;
  }

  try {
    const bmp = await createImageBitmap(file);
    const url = await drawToJpeg(bmp, bmp.width, bmp.height);
    bmp.close?.();
    return url;
  } catch (err) {
    console.warn("[decode] createImageBitmap failed, falling back to <img>:", err);
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () =>
        reject(
          new Error(
            isHeic
              ? "Your phone saved this photo as HEIC, which this browser can't decode. In iPhone Settings → Camera → Formats, switch to 'Most Compatible', or retake as JPEG."
              : `Browser could not decode this image (type: ${type || "unknown"}).`,
          ),
        );
      el.src = objectUrl;
    });
    if (!img.naturalWidth || !img.naturalHeight) {
      throw new Error("Decoded image has zero dimensions — the file is likely truncated.");
    }
    return await drawToJpeg(img, img.naturalWidth, img.naturalHeight);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/**
 * Split a source image/video into 16 preprocessed tiles.
 * Preprocessing: grayscale + auto-invert (so text is always dark-on-white) +
 * contrast stretch + Otsu-ish binary threshold. Returns base64 PNGs.
 */
async function splitAndPreprocessTiles(
  source: CanvasImageSource,
  srcW: number,
  srcH: number,
  opts?: { inset?: number; tilePx?: number },
): Promise<string[]> {
  const inset = opts?.inset ?? 0.03;
  const tilePx = opts?.tilePx ?? 96;
  const usableW = srcW * (1 - inset * 2);
  const usableH = srcH * (1 - inset * 2);
  const offX = srcW * inset;
  const offY = srcH * inset;
  const cellW = usableW / 4;
  const cellH = usableH / 4;
  const tiles: string[] = [];
  const canvas = document.createElement("canvas");
  canvas.width = tilePx;
  canvas.height = tilePx;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("Canvas 2D unavailable");

  const pad = 0.12; // shrink each tile slightly to drop borders
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const sx = offX + c * cellW + cellW * pad;
      const sy = offY + r * cellH + cellH * pad;
      const sw = cellW * (1 - pad * 2);
      const sh = cellH * (1 - pad * 2);
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, tilePx, tilePx);
      ctx.drawImage(source, sx, sy, sw, sh, 0, 0, tilePx, tilePx);

      const img = ctx.getImageData(0, 0, tilePx, tilePx);
      const d = img.data;
      // grayscale + mean
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) {
        const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        d[i] = d[i + 1] = d[i + 2] = g;
        sum += g;
      }
      const mean = sum / (d.length / 4);
      // If background is darker than text, invert so text becomes dark on light.
      const invert = mean < 128;
      // Threshold at (mean +/- delta) with mild contrast stretch.
      const thr = invert ? 255 - mean * 0.9 : mean * 1.05;
      for (let i = 0; i < d.length; i += 4) {
        let g = d[i];
        if (invert) g = 255 - g;
        const bin = g > thr ? 255 : 0;
        d[i] = d[i + 1] = d[i + 2] = bin;
      }
      ctx.putImageData(img, 0, 0);
      tiles.push(canvas.toDataURL("image/png"));
    }
  }
  return tiles;
}

async function fileToTiles(file: File): Promise<string[]> {
  try {
    const bmp = await createImageBitmap(file);
    const tiles = await splitAndPreprocessTiles(bmp, bmp.width, bmp.height);
    bmp.close?.();
    return tiles;
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise<HTMLImageElement>((res, rej) => {
        const el = new Image();
        el.onload = () => res(el);
        el.onerror = () => rej(new Error("Could not decode image"));
        el.src = url;
      });
      return await splitAndPreprocessTiles(img, img.naturalWidth, img.naturalHeight);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

function WordAssistant() {
  const [manual, setManual] = useState<string[]>(DEFAULT_GRID);
  const [scanned, setScanned] = useState<string[]>(EMPTY_GRID);
  const [active, setActive] = useState<GridId>("manual");
  const [results, setResults] = useState<Path[]>([]);
  const [topWords, setTopWords] = useState<Path[] | null>(null);
  const [ready, setReady] = useState(false);
  const [solving, setSolving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hovered, setHovered] = useState<Path | null>(null);
  const [trace, setTrace] = useState<TraceState | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const trieRef = useRef<DictionaryTrie | null>(null);
  const traceRunRef = useRef(0);
  const pendingTraceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [liveOn, setLiveOn] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);
  const [liveStatus, setLiveStatus] = useState<"idle" | "starting" | "watching" | "scanning">("idle");
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [nowTs, setNowTs] = useState<number>(Date.now());
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const scanningRef = useRef(false);
  const liveOnRef = useRef(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const scannedRef = useRef<string[]>(scanned);
  const manualRef = useRef<string[]>(manual);
  const [settings, setSettings] = useState<SyncSettings>(DEFAULT_SETTINGS);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => { setSettings(loadSettings()); }, []);
  useEffect(() => {
    try { window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {}
  }, [settings]);

  useEffect(() => {
    loadTrie().then((trie) => {
      trieRef.current = trie;
      setReady(true);
    });
  }, []);

  useEffect(() => { scannedRef.current = scanned; }, [scanned]);
  useEffect(() => { manualRef.current = manual; }, [manual]);

  useEffect(() => {
    if (!liveOn) return;
    const id = setInterval(() => setNowTs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [liveOn]);

  const activeLetters = active === "manual" ? manual : scanned;
  const grid = useMemo(() => activeLetters.map((c) => (c || " ").toLowerCase()), [activeLetters]);

  useEffect(() => {
    if (!ready) return;
    if (grid.some((c) => !/[a-z]/.test(c))) {
      setResults([]);
      return;
    }
    setSolving(true);
    const id = setTimeout(() => {
      loadTrie().then((trie) => {
        trieRef.current = trie;
        setResults(filterValidPaths(solve(grid, trie), trie));
        setSolving(false);
      });
    }, settings.debounceMs);
    return () => clearTimeout(id);
  }, [grid, ready]);

  function setManualCell(i: number, v: string) {
    const ch = v.slice(-1).toUpperCase();
    if (ch && !/[A-Z]/.test(ch)) return;
    setTopWords(null);
    setTrace(null);
    setManual((prev) => {
      const n = [...prev];
      n[i] = ch;
      return n;
    });
    if (ch) {
      const next = document.querySelector<HTMLInputElement>(`input[data-manual="${i + 1}"]`);
      next?.focus();
    }
  }

  const [uploadMs, setUploadMs] = useState<number | null>(null);
  const [scanDebug, setScanDebug] = useState<string[][] | null>(null);
  const [tileResults, setTileResults] = useState<Array<{ index: number; letter: string; confidence: number | null; error?: string; rawText?: string; attempt?: string }> | null>(null);
  const [rawOcrJson, setRawOcrJson] = useState<any>(null);
  const [showRaw, setShowRaw] = useState(false);



  async function solveValidated(letters: string[]): Promise<Path[]> {
    const trie = trieRef.current ?? (await loadTrie());
    trieRef.current = trie;
    const normalized = letters.map((c) => (c || "").toLowerCase());
    if (normalized.some((c) => !/^[a-z]$/.test(c))) return [];
    return filterValidPaths(solve(normalized, trie), trie);
  }

  function mergeDetectedLetters(previous: string[], detected: string[]) {
    const next = [...previous];
    let changed = 0;
    for (let i = 0; i < 16; i++) {
      const nc = (detected[i] || "").toUpperCase().replace(/[^A-Z]/g, "").slice(0, 1);
      if (nc && nc !== (previous[i] || "").toUpperCase()) {
        next[i] = nc;
        changed++;
      }
    }
    return { next, changed };
  }

  async function autoTrace(path: Path, gridId: GridId = "manual") {
    const run = ++traceRunRef.current;
    setHovered(null);
    setActive(gridId);
    for (let step = 1; step <= path.cells.length; step++) {
      if (run !== traceRunRef.current) return;
      setTrace({ gridId, path, step, locked: false });
      await new Promise((resolve) => setTimeout(resolve, 140));
    }
    if (run === traceRunRef.current) {
      setTrace({ gridId, path, step: path.cells.length, locked: true });
      // #7 — after locking a word on Manual, auto-reset selection so it's ready for the next word.
      if (gridId === "manual") {
        setTimeout(() => {
          if (run === traceRunRef.current) {
            setTrace(null);
            setHovered(null);
          }
        }, 1500);
      }
    }
  }

  function scheduleTrace(path: Path, gridId: GridId, delayMs: number) {
    if (pendingTraceRef.current) clearTimeout(pendingTraceRef.current);
    pendingTraceRef.current = setTimeout(() => {
      pendingTraceRef.current = null;
      void autoTrace(path, gridId);
    }, delayMs);
  }

  async function processFile(file: File) {
    setError(null);
    setUploading(true);
    setUploadMs(null);
    const t0 = performance.now();
    try {
      const tiles = await fileToTiles(file);
      console.log("[OCR] recognising", tiles.length, "tiles on-device");
      const resp = await ocrTiles(tiles);
      const { rows, letters: got, tiles: tRes } = resp;
      setScanned(got);
      scannedRef.current = got;
      setScanDebug(rows);
      setTileResults(tRes);
      setRawOcrJson(resp);
      setActive("scanned");
      setTopWords(null);
      setTrace(null);
    } catch (err: any) {
      setError(err?.message ?? String(err) ?? "Failed to read grid");
    } finally {
      setUploadMs(Math.round(performance.now() - t0));
      setUploading(false);
    }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) await processFile(file);
  }

  async function captureFrameTiles(): Promise<string[] | null> {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) return null;
    return await splitAndPreprocessTiles(video, video.videoWidth, video.videoHeight);
  }

  async function runScanCycle(reason: "live" | "rescan") {
    if (scanningRef.current) return;
    scanningRef.current = true;
    setLiveStatus("scanning");
    try {
      const tiles = await captureFrameTiles();
      if (!tiles) return;
      const resp = await ocrTiles(tiles);
      const { rows, letters: got, tiles: tRes } = resp;
      const { next, changed } = mergeDetectedLetters(scannedRef.current, got);
      if (changed > 0 || reason === "rescan") {
        scannedRef.current = next;
        setScanned(next);
        setManual(next);
        setActive("manual");
        const valid = await solveValidated(next);
        setResults(valid);
        setTopWords(valid.slice(0, DISPLAY_LIMIT));
        if (valid[0]) scheduleTrace(valid[0], "manual", TRACE_DELAY_MS);
      }
      setScanDebug(rows);
      setTileResults(tRes ?? null);
      setRawOcrJson(resp);
      setLastSyncAt(Date.now());
    } catch (err: any) {
      setLiveError(err?.message ?? "Live scan failed");
    } finally {
      scanningRef.current = false;
      if (liveOnRef.current) setLiveStatus("watching");
      else setLiveStatus("idle");
    }
  }


  async function startLiveSync() {
    setLiveError(null);
    setLiveStatus("starting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current!;
      video.srcObject = stream;
      video.setAttribute("playsinline", "true");
      await video.play();
      liveOnRef.current = true;
      setLiveOn(true);
      setLiveStatus("watching");
      runScanCycle("live");
      intervalRef.current = setInterval(() => runScanCycle("live"), settings.scanIntervalMs);
    } catch (err: any) {
      setLiveError(err?.message ?? "Could not start camera");
      setLiveStatus("idle");
      stopLiveSync();
    }
  }

  function stopLiveSync() {
    liveOnRef.current = false;
    setLiveOn(false);
    setLiveStatus("idle");
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
    const s = streamRef.current;
    if (s) { s.getTracks().forEach((t) => t.stop()); streamRef.current = null; }
    if (videoRef.current) videoRef.current.srcObject = null;
  }

  async function rescanNow() {
    if (!liveOn) {
      setLiveError("Start Live Sync first to enable Rescan.");
      return;
    }
    // Force a scan even if the previous one is still running: wait briefly, then run.
    const started = performance.now();
    while (scanningRef.current && performance.now() - started < 2000) {
      await new Promise((r) => setTimeout(r, 50));
    }
    await runScanCycle("rescan");
  }

  useEffect(() => () => stopLiveSync(), []);

  const grouped = useMemo(() => {
    const g = new Map<number, Path[]>();
    const visible = (topWords ?? results).slice(0, DISPLAY_LIMIT);
    for (const p of visible) {
      const arr = g.get(p.word.length) ?? [];
      arr.push(p);
      g.set(p.word.length, arr);
    }
    return Array.from(g.entries()).sort((a, b) => b[0] - a[0]);
  }, [results, topWords]);

  const showHover = (id: GridId) => (id === active ? hovered : null);

  // #8 — Grid match indicator
  const gridMatch = useMemo(() => {
    const diffs: number[] = [];
    for (let i = 0; i < 16; i++) {
      const a = (manual[i] || "").toUpperCase();
      const b = (scanned[i] || "").toUpperCase();
      if (a !== b) diffs.push(i);
    }
    const scannedEmpty = scanned.every((c) => !c);
    return { match: diffs.length === 0 && !scannedEmpty, diffs, scannedEmpty };
  }, [manual, scanned]);

  async function generateFromScanned() {
    setError(null);
    if (scanned.some((c) => !/[A-Za-z]/.test(c))) {
      setError("Scanned grid is empty — scan a photo first.");
      return;
    }
    const copy = scanned.map((c) => (c || "").toUpperCase());
    setManual(copy);
    setActive("manual");
    const all = await solveValidated(copy);
    setResults(all);
    setTopWords(all.slice(0, DISPLAY_LIMIT));
    if (all[0]) void autoTrace(all[0], "manual");
  }

  function GridBoard({
    id, letters, editable, label, mismatchCells,
  }: {
    id: GridId; letters: string[]; editable: boolean; label: string; mismatchCells?: number[];
  }) {
    const isActive = active === id;
    const h = showHover(id);
    const traceForBoard = trace?.gridId === id ? trace : null;
    const traceCells = traceForBoard ? traceForBoard.path.cells.slice(0, traceForBoard.step) : [];
    const tracePoints = traceCells
      .map((idx) => `${(idx % 4) * 25 + 12.5},${Math.floor(idx / 4) * 25 + 12.5}`)
      .join(" ");
    return (
      <div
        onClick={() => setActive(id)}
        className={[
          "flex flex-col items-center gap-3 rounded-2xl p-4 transition-all cursor-pointer backdrop-blur-sm",
          isActive ? "bg-black/60 ring-2 ring-pink-400" : "bg-black/50 ring-1 ring-white/10",
        ].join(" ")}
      >
        <div className="flex w-full items-center justify-between">
          <span className="text-sm font-semibold uppercase tracking-wider text-pink-300">{label}</span>
          {isActive && (
            <span className="text-[10px] font-semibold uppercase tracking-wider text-pink-400">Active</span>
          )}
        </div>
        <div className="relative grid w-full gap-[clamp(4px,1.2vw,10px)]" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
          {tracePoints && (
            <svg className="pointer-events-none absolute inset-0 z-20 h-full w-full" viewBox="0 0 100 100" preserveAspectRatio="none">
              <polyline
                points={tracePoints}
                fill="none"
                stroke={traceForBoard?.locked ? "#FBBF24" : "#FF69B4"}
                strokeWidth="3.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
          {letters.map((c, i) => {
            const traced = traceCells.includes(i);
            const highlighted = traced || h?.cells.includes(i);
            const order = traced ? traceCells.indexOf(i) : h ? h.cells.indexOf(i) : -1;
            const mismatched = mismatchCells?.includes(i);
            const base =
              "relative z-10 w-full rounded-lg text-center font-bold uppercase transition-all focus:outline-none focus:ring-2 focus:ring-white/70";
            const tileStyle: React.CSSProperties = { aspectRatio: "1 / 1", fontSize: "clamp(1rem, 3.6vw, 1.75rem)" };
            const tileColor = highlighted
              ? traceForBoard?.locked
                ? "bg-amber-300 text-black shadow-lg shadow-amber-300/40 scale-105"
                : "bg-white text-pink-600 shadow-lg scale-105"
              : "bg-[#FF69B4] text-white hover:bg-[#ff4fa8] active:scale-95 shadow-md shadow-pink-500/30";
            const mismatchRing = mismatched ? "ring-2 ring-red-500 ring-offset-1 ring-offset-black" : "";
            return (
              <div key={i} className="relative">
                {editable ? (
                  <input
                    data-manual={i}
                    value={c}
                    maxLength={1}
                    onChange={(e) => setManualCell(i, e.target.value)}
                    onFocus={(e) => { setActive("manual"); e.target.select(); }}
                    style={tileStyle}
                    className={`${base} ${tileColor} ${mismatchRing}`}
                  />
                ) : (
                  <div style={tileStyle} className={`${base} grid place-items-center ${c ? tileColor : "bg-white/10 text-white/40"} ${mismatchRing}`}>
                    {c || ""}
                  </div>
                )}
                {highlighted && order >= 0 && (
                  <span className="pointer-events-none absolute right-1 top-1 rounded-full bg-black/80 px-1.5 text-[10px] font-semibold text-pink-300">
                    {order + 1}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div
      className="min-h-screen text-white"
      style={{
        backgroundColor: "#000",
        backgroundImage: `linear-gradient(rgba(0,0,0,0.72), rgba(0,0,0,0.82)), url(${skullsBgAsset.url})`,
        backgroundRepeat: "repeat",
        backgroundSize: "auto",
      }}
    >
      <header className="border-b border-white/10 bg-black/60 backdrop-blur-sm">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-5">
          <div className="flex items-center gap-3">
            <div className="grid h-9 w-9 place-items-center rounded-md bg-[#FF69B4] text-white">
              <Sparkles className="h-4 w-4" />
            </div>
            <h1
              className="leading-none"
              style={{
                fontFamily: '"Great Vibes", "Alex Brush", cursive',
                color: "#ff007f",
                fontSize: "clamp(2.25rem, 6vw, 3.75rem)",
                textShadow: "0 0 12px rgba(255,0,127,0.55), 0 0 24px rgba(255,0,127,0.35)",
              }}
            >
              Grid Word Assistant
            </h1>
          </div>
          <div className="text-xs text-white/60">
            {ready ? `${results.length.toLocaleString()} words` : "Loading dictionary…"}
          </div>
        </div>
      </header>



      <main className="mx-auto grid max-w-6xl gap-8 px-4 py-8 lg:grid-cols-[auto_1fr]">
        <section className="flex flex-col items-center gap-4">
          {/* Strict horizontal three-column layout: Manual | Live Camera | Scanned */}
          <div className="grid w-full grid-cols-3 gap-4 items-start">
            <GridBoard id="manual" letters={manual} editable label="Manual Grid" mismatchCells={gridMatch.diffs} />

            <div className="flex flex-col items-center gap-3 rounded-2xl p-4 bg-black/50 ring-1 ring-white/10 backdrop-blur-sm">
              <span className="text-sm font-semibold uppercase tracking-wider text-pink-300">Live Camera</span>
              <div className={liveOn ? "relative w-full max-w-[220px] overflow-hidden rounded-lg border-2 border-red-500 bg-black" : "hidden"}>
                <video ref={videoRef} className="w-full" muted playsInline />
                <div className="absolute left-2 top-2 flex items-center gap-1.5 rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-red-400">
                  <span className={`h-2 w-2 rounded-full bg-red-500 ${liveStatus === "scanning" ? "animate-pulse" : ""}`} />
                  {liveStatus === "scanning" ? "Scanning…" : "Live"}
                </div>
              </div>
              {!liveOn && (
                <div className="grid h-[160px] w-full max-w-[220px] place-items-center rounded-lg border-2 border-dashed border-white/20 bg-black/40 text-xs text-white/50">
                  Camera off
                </div>
              )}
              <div className="flex flex-wrap justify-center gap-2">
                {!liveOn ? (
                  <button
                    onClick={startLiveSync}
                    disabled={uploading}
                    className="inline-flex items-center gap-1.5 rounded-md bg-red-500 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-red-400 active:scale-95 disabled:opacity-50"
                  >
                    <Radio className="h-3.5 w-3.5" /> Start
                  </button>
                ) : (
                  <button
                    onClick={stopLiveSync}
                    className="inline-flex items-center gap-1.5 rounded-md bg-white text-black px-2.5 py-1.5 text-xs font-semibold hover:bg-white/90 active:scale-95"
                  >
                    <StopCircle className="h-3.5 w-3.5" /> Stop
                  </button>
                )}
                {/* #6 — Rescan */}
                <button
                  onClick={rescanNow}
                  disabled={!liveOn}
                  className="inline-flex items-center gap-1.5 rounded-md bg-pink-500 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-pink-400 active:scale-95 disabled:opacity-40"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${liveStatus === "scanning" ? "animate-spin" : ""}`} /> Rescan
                </button>
                <button
                  onClick={() => setShowSettings((s) => !s)}
                  className="inline-flex items-center gap-1.5 rounded-md border border-white/20 bg-white/5 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-white/10"
                  title="Sync settings"
                >
                  <Settings className="h-3.5 w-3.5" />
                </button>
              </div>
              {/* #8 — Grid match indicator */}
              <div
                className={[
                  "w-full rounded-md px-2 py-1.5 text-center text-xs font-semibold",
                  gridMatch.scannedEmpty
                    ? "bg-white/5 text-white/50"
                    : gridMatch.match
                      ? "bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-400/60"
                      : "bg-red-500/20 text-red-300 ring-1 ring-red-400/60",
                ].join(" ")}
              >
                {gridMatch.scannedEmpty
                  ? "No scanned grid yet"
                  : gridMatch.match
                    ? "✓ Grids Match"
                    : `⚠ Grid Mismatch (${gridMatch.diffs.length} tile${gridMatch.diffs.length === 1 ? "" : "s"})`}
              </div>
              {lastSyncAt && (
                <p className="text-[10px] text-white/60">
                  Synced {Math.max(0, Math.round((nowTs - lastSyncAt) / 1000))}s ago
                </p>
              )}
              {showSettings && (
                <div className="w-full rounded-md border border-white/15 bg-black/70 p-2 text-[11px] text-white/80">
                  <div className="mb-1 font-semibold text-pink-300">Sync Settings</div>
                  <label className="mb-1.5 block">
                    Scan interval: {settings.scanIntervalMs}ms
                    <input
                      type="range" min={1000} max={5000} step={100}
                      value={settings.scanIntervalMs}
                      onChange={(e) => setSettings((s) => ({ ...s, scanIntervalMs: Number(e.target.value) }))}
                      className="w-full accent-pink-500"
                    />
                  </label>
                  <label className="block">
                    Debounce: {settings.debounceMs}ms
                    <input
                      type="range" min={0} max={200} step={5}
                      value={settings.debounceMs}
                      onChange={(e) => setSettings((s) => ({ ...s, debounceMs: Number(e.target.value) }))}
                      className="w-full accent-pink-500"
                    />
                  </label>
                  <p className="mt-1 text-[10px] text-white/50">Changes to interval apply on next Start.</p>
                </div>
              )}
            </div>

            <GridBoard id="scanned" letters={scanned} editable={false} label="Scanned Grid" mismatchCells={gridMatch.diffs} />
          </div>

          {/* Centered Online status badge — own row below grids */}
          <div
            className="flex items-center gap-3 rounded-xl border border-pink-400/70 bg-black/70 px-4 py-2"
            style={{
              boxShadow: "0 0 12px rgba(255,0,127,0.85), 0 0 28px rgba(255,0,127,0.55)",
            }}
          >
            <img src={onlineNowAsset.url} alt="online now badge" className="h-8 w-auto" />
            <span
              className="flex items-center gap-1.5"
              style={{
                fontFamily: '"Press Start 2P", monospace',
                color: "#ff007f",
                fontSize: "0.72rem",
                textShadow: "0 0 6px #ff007f, 0 0 12px rgba(255,105,180,0.9)",
              }}
            >
              <span className="inline-block h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
              Online
            </span>
          </div>


          <div className="flex flex-wrap justify-center gap-2">
            <button
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="inline-flex items-center gap-2 rounded-md bg-[#FF69B4] px-3 py-2 text-sm font-semibold text-white hover:bg-[#ff4fa8] active:scale-95 disabled:opacity-50"
            >
              {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              {uploading ? "Reading grid…" : "Upload grid photo"}
            </button>
            <button
              onClick={() => cameraRef.current?.click()}
              disabled={uploading}
              className="inline-flex items-center gap-2 rounded-md bg-[#FF69B4] px-3 py-2 text-sm font-semibold text-white hover:bg-[#ff4fa8] active:scale-95 disabled:opacity-50"
            >
              <Camera className="h-4 w-4" /> Upload new grid
            </button>
            <button
              onClick={generateFromScanned}
              disabled={uploading}
              className="inline-flex items-center gap-2 rounded-md bg-emerald-500 px-3 py-2 text-sm font-semibold text-black hover:bg-emerald-400 active:scale-95 disabled:opacity-50"
            >
              <Wand2 className="h-4 w-4" /> Generate
            </button>
            <button
              onClick={() => {
                setTopWords(null); setTrace(null);
                setManual(randomGrid()); setActive("manual");
              }}
              className="inline-flex items-center gap-2 rounded-md border border-white/20 bg-white/5 px-3 py-2 text-sm font-medium text-white hover:bg-white/10"
            >
              <Shuffle className="h-4 w-4" /> Random
            </button>
            <button
              onClick={() => {
                setManual(EMPTY_GRID); setActive("manual"); setTopWords(null); setTrace(null);
              }}
              className="inline-flex items-center gap-2 rounded-md border border-white/20 bg-white/5 px-3 py-2 text-sm font-medium text-white hover:bg-white/10"
            >
              <Eraser className="h-4 w-4" /> Clear grid
            </button>
            <button
              onClick={() => {
                setScanned(EMPTY_GRID); scannedRef.current = EMPTY_GRID; setScanDebug(null); setTrace(null);
              }}
              className="rounded-md border border-white/20 bg-white/5 px-3 py-2 text-sm font-medium text-white hover:bg-white/10"
            >
              Clear scanned
            </button>
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onFile} />
            <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={onFile} />
          </div>

          {liveError && <p className="max-w-md text-center text-sm text-red-400">{liveError}</p>}
          {error && <p className="max-w-md text-center text-sm text-red-400 whitespace-pre-wrap">{error}</p>}
          {uploadMs !== null && !uploading && !error && (
            <p className={`text-xs ${uploadMs < 2000 ? "text-green-400" : "text-yellow-400"}`}>
              Scan completed in {uploadMs} ms {uploadMs < 2000 ? "✓ under 2s target" : "(over 2s target)"}
            </p>
          )}
          {scanDebug && (
            <div className="w-full max-w-md rounded-md border border-white/10 bg-white/5 px-3 py-2 text-xs font-mono text-white/80">
              <div className="mb-1 text-pink-300">Row/col mapping:</div>
              {scanDebug.map((r, i) => (<div key={i}>row {i}: {r.join(" · ")}</div>))}
              {tileResults && (
                <div className="mt-2 border-t border-white/10 pt-2">
                  <div className="mb-1 text-pink-300">Per-tile OCR results:</div>
                  <div className="grid grid-cols-4 gap-1">
                    {tileResults.map((t) => (
                      <div
                        key={t.index}
                        className={[
                          "rounded px-1 py-1 text-center",
                          t.letter
                            ? "bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-400/40"
                            : "bg-red-500/20 text-red-300 ring-1 ring-red-400/40",
                        ].join(" ")}
                        title={t.error || t.rawText || ""}
                      >
                        <div className="text-sm font-bold">{t.letter || "∅"}</div>
                        <div className="text-[9px] opacity-70">
                          {t.confidence != null ? `${Math.round(t.confidence * 100)}%` : t.error ? "err" : "—"}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {rawOcrJson && (
                <div className="mt-2 border-t border-white/10 pt-2">
                  <button
                    onClick={() => setShowRaw((s) => !s)}
                    className="text-pink-300 underline hover:text-pink-200"
                  >
                    {showRaw ? "Hide" : "Show"} raw OCR response
                  </button>
                  {showRaw && (
                    <pre className="mt-1 max-h-64 overflow-auto rounded bg-black/60 p-2 text-[10px] leading-tight text-white/70">
                      {JSON.stringify(rawOcrJson, null, 2)}
                    </pre>
                  )}
                </div>
              )}
            </div>
          )}
          <p className="max-w-md text-center text-xs text-white/50">
            Click a grid to make it active. Letters connect in all 8 directions; each tile is used once per word.
            All words are validated against a local English dictionary.
          </p>
        </section>

        <section className="min-w-0">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white/70">
              {topWords ? `Top ${topWords.length} words (Generate)` : `Found words in ${active === "manual" ? "Manual" : "Scanned"} grid`}{" "}
              {solving && <Loader2 className="ml-1 inline h-3 w-3 animate-spin" />}
            </h2>
          </div>
          {!ready && <p className="text-sm text-white/50">Loading English dictionary…</p>}

          {topWords && (
            <div className="mb-4 rounded-md border border-emerald-400/40 bg-emerald-400/5 p-3">
              <div className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-emerald-300">
                Top {topWords.length} · longest first
              </div>
              <div className="flex flex-wrap gap-1.5">
                {topWords.map((p) => (
                  <button
                    key={p.word}
                    onMouseEnter={() => setHovered(p)}
                    onMouseLeave={() => setHovered(null)}
                    onClick={() => void autoTrace(p, "manual")}
                    className="rounded-md border border-emerald-400/40 bg-emerald-400/10 px-2 py-1 text-sm font-medium capitalize text-emerald-100"
                  >
                    {p.word}
                  </button>
                ))}
              </div>
            </div>
          )}

          {ready && results.length === 0 && (<p className="text-sm text-white/50">Fill every cell to see valid words.</p>)}
          <div className="space-y-4">
            {grouped.map(([len, words]) => (
              <div key={len}>
                <div className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-pink-300">
                  {len} letters · {words.length}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {words.map((p) => (
                    <button
                      key={p.word}
                      onMouseEnter={() => setHovered(p)}
                      onMouseLeave={() => setHovered(null)}
                      onFocus={() => setHovered(p)}
                      onBlur={() => setHovered(null)}
                      onClick={() => void autoTrace(p, active)}
                      className="rounded-md border border-white/15 bg-white/5 px-2 py-1 text-sm font-medium capitalize text-white transition-colors hover:border-pink-400 hover:bg-pink-400/10"
                    >
                      {p.word}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      </main>

      {/* #3 — footer */}
      <footer className="border-t border-white/10 bg-black/70 py-8 text-center">
        <p
          style={{
            fontFamily: '"Great Vibes", "Alex Brush", cursive',
            fontSize: "clamp(1.75rem, 4vw, 2.5rem)",
            color: "#ffd6ec",
            textShadow:
              "0 0 6px #fff, 0 0 12px #ff69b4, 0 0 22px #ff007f, 0 0 36px rgba(255,0,127,0.6)",
          }}
        >
          Vibe Coded by Jazzy Raielle, xoxo
        </p>
        <p className="mt-3 text-xs text-white/50">
          © {new Date().getFullYear()} Jazzy Raielle. All rights reserved.
        </p>
      </footer>
    </div>
  );
}
