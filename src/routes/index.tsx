import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { extractGrid } from "@/lib/grid-ocr.functions";
import { loadTrie, solve, type Path } from "@/lib/solver";
import { Upload, Loader2, Shuffle, Sparkles, Camera, Wand2, Eraser, Radio, StopCircle } from "lucide-react";

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

function randomGrid(): string[] {
  const dice = "AAAAAABBCCDDEEEEEEFFGGHHIIIIJKLLMMNNNNOOOOPPQRRRSSSSTTTTUUVVWWXYYZ";
  return Array.from({ length: 16 }, () => dice[Math.floor(Math.random() * dice.length)]);
}

type GridId = "manual" | "scanned";

// Robust image → JPEG data URL. Handles HEIC/HEIC-ish by falling back to <img> decode.
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

  // Path 1: createImageBitmap (fast; supports JPEG/PNG/WebP; Safari 17+ supports HEIC).
  try {
    const bmp = await createImageBitmap(file);
    const url = await drawToJpeg(bmp, bmp.width, bmp.height);
    bmp.close?.();
    return url;
  } catch (err) {
    console.warn("[decode] createImageBitmap failed, falling back to <img>:", err);
  }

  // Path 2: HTMLImageElement via object URL (works for anything the browser can render).
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
  const fileRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const extract = useServerFn(extractGrid);

  // ----- Live Sync state -----
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

  useEffect(() => {
    loadTrie().then(() => setReady(true));
  }, []);

  useEffect(() => {
    if (!liveOn) return;
    const id = setInterval(() => setNowTs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [liveOn]);

  const activeLetters = active === "manual" ? manual : scanned;
  const grid = useMemo(
    () => activeLetters.map((c) => (c || " ").toLowerCase()),
    [activeLetters],
  );

  useEffect(() => {
    if (!ready) return;
    setTopWords(null);
    if (grid.some((c) => !/[a-z]/.test(c))) {
      setResults([]);
      return;
    }
    setSolving(true);
    const id = setTimeout(() => {
      loadTrie().then((trie) => {
        setResults(solve(grid, trie));
        setSolving(false);
      });
    }, 10);
    return () => clearTimeout(id);
  }, [grid, ready]);

  function setManualCell(i: number, v: string) {
    const ch = v.slice(-1).toUpperCase();
    if (ch && !/[A-Z]/.test(ch)) return;
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

  async function processFile(file: File) {
    setError(null);
    setUploading(true);
    setUploadMs(null);
    const t0 = performance.now();
    try {
      console.log("[upload] file:", { name: file.name, type: file.type, size: file.size });
      const dataUrl = await fileToJpegDataUrl(file, 512);
      const { rows, letters: got } = await extract({ data: { imageDataUrl: dataUrl } });
      setScanned(got);
      setScanDebug(rows);
      setActive("scanned");
      console.log("[OCR] Row/col mapping:");
      rows.forEach((r, i) => console.log(`  row ${i}:`, r.join(" ")));
    } catch (err: any) {
      const msg = err?.message ?? String(err) ?? "Failed to read grid";
      console.error("[upload] failed:", err);
      setError(msg);
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

  async function captureFrameJpeg(maxDim = 512): Promise<string | null> {
    const video = videoRef.current;
    if (!video || !video.videoWidth || !video.videoHeight) return null;
    const w = video.videoWidth, h = video.videoHeight;
    const scale = Math.min(1, maxDim / Math.max(w, h));
    const dw = Math.max(1, Math.round(w * scale));
    const dh = Math.max(1, Math.round(h * scale));
    const canvas = document.createElement("canvas");
    canvas.width = dw; canvas.height = dh;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, dw, dh);
    return canvas.toDataURL("image/jpeg", 0.8);
  }

  async function liveTick() {
    if (!liveOnRef.current || scanningRef.current) return;
    scanningRef.current = true;
    setLiveStatus("scanning");
    try {
      const dataUrl = await captureFrameJpeg(512);
      if (!dataUrl) return;
      const { rows, letters: got } = await extract({ data: { imageDataUrl: dataUrl } });
      // Diff: only replace changed tiles
      setScanned((prev) => {
        const next = [...prev];
        let changed = 0;
        for (let i = 0; i < 16; i++) {
          const nc = (got[i] || "").toUpperCase();
          if (nc && nc !== (prev[i] || "").toUpperCase()) {
            next[i] = nc;
            changed++;
          }
        }
        console.log("[live] diff — changed", changed, "tiles");
        return changed > 0 ? next : prev;
      });
      setScanDebug(rows);
      setLastSyncAt(Date.now());
      setActive("scanned");
    } catch (err: any) {
      console.error("[live] scan failed:", err);
      setLiveError(err?.message ?? "Live scan failed");
    } finally {
      scanningRef.current = false;
      if (liveOnRef.current) setLiveStatus("watching");
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
      // Attach to a video element (created via ref in JSX below).
      const video = videoRef.current!;
      video.srcObject = stream;
      video.setAttribute("playsinline", "true");
      await video.play();
      liveOnRef.current = true;
      setLiveOn(true);
      setLiveStatus("watching");
      // Fire first scan immediately, then every 2.5s.
      liveTick();
      intervalRef.current = setInterval(liveTick, 2500);
    } catch (err: any) {
      console.error("[live] start failed:", err);
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

  useEffect(() => () => stopLiveSync(), []);

  const grouped = useMemo(() => {
    const g = new Map<number, Path[]>();
    for (const p of results) {
      const arr = g.get(p.word.length) ?? [];
      arr.push(p);
      g.set(p.word.length, arr);
    }
    return Array.from(g.entries()).sort((a, b) => b[0] - a[0]);
  }, [results]);

  const showHover = (id: GridId) => (id === active ? hovered : null);

  async function generateFromScanned() {
    setError(null);
    if (scanned.some((c) => !/[A-Za-z]/.test(c))) {
      setError("Scanned grid is empty — scan a photo first.");
      return;
    }
    const copy = scanned.map((c) => (c || "").toUpperCase());
    setManual(copy);
    setActive("manual");
    const trie = await loadTrie();
    const lower = copy.map((c) => c.toLowerCase());
    const all = solve(lower, trie);
    setResults(all);
    setTopWords(all.slice(0, 10));
  }

  function GridBoard({
    id,
    letters,
    editable,
    label,
  }: {
    id: GridId;
    letters: string[];
    editable: boolean;
    label: string;
  }) {
    const isActive = active === id;
    const h = showHover(id);
    return (
      <div
        onClick={() => setActive(id)}
        className={[
          "flex flex-col items-center gap-3 rounded-2xl p-4 transition-all cursor-pointer",
          isActive ? "bg-white/5 ring-2 ring-pink-400" : "bg-white/[0.02] ring-1 ring-white/10",
        ].join(" ")}
      >
        <div className="flex w-full items-center justify-between">
          <span className="text-sm font-semibold uppercase tracking-wider text-pink-300">
            {label}
          </span>
          {isActive && (
            <span className="text-[10px] font-semibold uppercase tracking-wider text-pink-400">
              Active
            </span>
          )}
        </div>
        <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}>
          {letters.map((c, i) => {
            const highlighted = h?.cells.includes(i);
            const order = h ? h.cells.indexOf(i) : -1;
            const base =
              "h-14 w-14 rounded-lg text-center text-2xl font-bold uppercase transition-all sm:h-16 sm:w-16 sm:text-3xl focus:outline-none focus:ring-2 focus:ring-white/70";
            const tileColor = highlighted
              ? "bg-white text-pink-600 shadow-lg scale-105"
              : "bg-[#FF69B4] text-white hover:bg-[#ff4fa8] active:scale-95 shadow-md shadow-pink-500/30";
            return (
              <div key={i} className="relative">
                {editable ? (
                  <input
                    data-manual={i}
                    value={c}
                    maxLength={1}
                    onChange={(e) => setManualCell(i, e.target.value)}
                    onFocus={(e) => {
                      setActive("manual");
                      e.target.select();
                    }}
                    className={`${base} ${tileColor}`}
                  />
                ) : (
                  <div
                    className={`${base} grid place-items-center ${
                      c ? tileColor : "bg-white/10 text-white/40"
                    }`}
                  >
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
    <div className="min-h-screen bg-black text-white">
      <header className="border-b border-white/10">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-5">
          <div className="flex items-center gap-2">
            <div className="grid h-8 w-8 place-items-center rounded-md bg-[#FF69B4] text-white">
              <Sparkles className="h-4 w-4" />
            </div>
            <h1 className="text-lg font-semibold tracking-tight">Grid Word Assistant</h1>
          </div>
          <div className="text-xs text-white/60">
            {ready ? `${results.length.toLocaleString()} words` : "Loading dictionary…"}
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-6xl gap-8 px-4 py-8 lg:grid-cols-[auto_1fr]">
        <section className="flex flex-col items-center gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <GridBoard id="manual" letters={manual} editable label="Manual Grid" />
            <GridBoard id="scanned" letters={scanned} editable={false} label="Scanned Grid" />
          </div>

          <div className="flex flex-wrap justify-center gap-2">
            {!liveOn ? (
              <button
                onClick={startLiveSync}
                disabled={uploading}
                className="inline-flex items-center gap-2 rounded-md bg-red-500 px-3 py-2 text-sm font-semibold text-white hover:bg-red-400 active:scale-95 disabled:opacity-50"
              >
                <Radio className="h-4 w-4" /> Start Live Sync
              </button>
            ) : (
              <button
                onClick={stopLiveSync}
                className="inline-flex items-center gap-2 rounded-md bg-white text-black px-3 py-2 text-sm font-semibold hover:bg-white/90 active:scale-95"
              >
                <StopCircle className="h-4 w-4" /> Stop Live Sync
              </button>
            )}
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
              <Camera className="h-4 w-4" />
              Upload new grid
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
                setManual(randomGrid());
                setActive("manual");
              }}
              className="inline-flex items-center gap-2 rounded-md border border-white/20 bg-white/5 px-3 py-2 text-sm font-medium text-white hover:bg-white/10"
            >
              <Shuffle className="h-4 w-4" /> Random
            </button>
            <button
              onClick={() => {
                setManual(EMPTY_GRID);
                setActive("manual");
                setTopWords(null);
              }}
              className="inline-flex items-center gap-2 rounded-md border border-white/20 bg-white/5 px-3 py-2 text-sm font-medium text-white hover:bg-white/10"
            >
              <Eraser className="h-4 w-4" /> Clear grid
            </button>
            <button
              onClick={() => {
                setScanned(EMPTY_GRID);
                setScanDebug(null);
              }}
              className="rounded-md border border-white/20 bg-white/5 px-3 py-2 text-sm font-medium text-white hover:bg-white/10"
            >
              Clear scanned
            </button>
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onFile} />
            <input
              ref={cameraRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={onFile}
            />
          </div>

          {/* Live sync viewport — hidden until active */}
          <div className={liveOn ? "flex flex-col items-center gap-2" : "hidden"}>
            <div className="relative w-full max-w-xs overflow-hidden rounded-lg border-2 border-red-500 bg-black">
              <video ref={videoRef} className="w-full" muted playsInline />
              <div className="absolute left-2 top-2 flex items-center gap-1.5 rounded-full bg-black/70 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-red-400">
                <span className={`h-2 w-2 rounded-full bg-red-500 ${liveStatus === "scanning" ? "animate-pulse" : ""}`} />
                {liveStatus === "scanning" ? "Scanning…" : "Live"}
              </div>
            </div>
            <p className="text-xs text-white/70">
              {lastSyncAt
                ? `Synced ${Math.max(0, Math.round((nowTs - lastSyncAt) / 1000))}s ago`
                : "Waiting for first scan…"}
            </p>
          </div>
          {/* Hidden video ref holder for when liveOn is false (keeps ref stable) */}
          {!liveOn && <video ref={videoRef} className="hidden" muted playsInline />}

          {liveError && (
            <p className="max-w-md text-center text-sm text-red-400">{liveError}</p>
          )}
          {error && (
            <p className="max-w-md text-center text-sm text-red-400 whitespace-pre-wrap">{error}</p>
          )}
          {uploadMs !== null && !uploading && !error && (
            <p className={`text-xs ${uploadMs < 2000 ? "text-green-400" : "text-yellow-400"}`}>
              Scan completed in {uploadMs} ms {uploadMs < 2000 ? "✓ under 2s target" : "(over 2s target)"}
            </p>
          )}
          {scanDebug && (
            <div className="rounded-md border border-white/10 bg-white/5 px-3 py-2 text-xs font-mono text-white/80">
              <div className="mb-1 text-pink-300">Row/col mapping (verify against image):</div>
              {scanDebug.map((r, i) => (
                <div key={i}>row {i}: {r.join(" · ")}</div>
              ))}
            </div>
          )}
          <p className="max-w-md text-center text-xs text-white/50">
            Click a grid to make it active. Letters connect in all 8 directions; each tile is used
            once per word. All words are validated against a local English dictionary.
          </p>
        </section>

        <section className="min-w-0">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white/70">
              {topWords ? "Top 10 words (Generate)" : `Found words in ${active === "manual" ? "Manual" : "Scanned"} grid`}{" "}
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
                    className="rounded-md border border-emerald-400/40 bg-emerald-400/10 px-2 py-1 text-sm font-medium capitalize text-emerald-100"
                  >
                    {p.word}
                  </button>
                ))}
              </div>
            </div>
          )}

          {ready && results.length === 0 && (
            <p className="text-sm text-white/50">Fill every cell to see valid words.</p>
          )}
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
    </div>
  );
}
