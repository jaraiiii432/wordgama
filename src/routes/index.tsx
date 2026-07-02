import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { extractGrid } from "@/lib/grid-ocr.functions";
import { loadTrie, solve, type Path } from "@/lib/solver";
import { Upload, Loader2, Shuffle, Sparkles } from "lucide-react";

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

function WordAssistant() {
  const [manual, setManual] = useState<string[]>(DEFAULT_GRID);
  const [scanned, setScanned] = useState<string[]>(EMPTY_GRID);
  const [active, setActive] = useState<GridId>("manual");
  const [results, setResults] = useState<Path[]>([]);
  const [ready, setReady] = useState(false);
  const [solving, setSolving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hovered, setHovered] = useState<Path | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const extract = useServerFn(extractGrid);

  useEffect(() => {
    loadTrie().then(() => setReady(true));
  }, []);

  const activeLetters = active === "manual" ? manual : scanned;
  const grid = useMemo(
    () => activeLetters.map((c) => (c || " ").toLowerCase()),
    [activeLetters],
  );

  useEffect(() => {
    if (!ready) return;
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

  async function resizeImage(file: File, maxDim = 512): Promise<string> {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    return canvas.toDataURL("image/jpeg", 0.8);
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setUploading(true);
    setUploadMs(null);
    const t0 = performance.now();
    try {
      const dataUrl = await resizeImage(file, 512);
      const { rows, letters: got } = await extract({ data: { imageDataUrl: dataUrl } });
      setScanned(got);
      setScanDebug(rows);
      setActive("scanned");
      console.log("[OCR] Row/col mapping:");
      rows.forEach((r, i) => console.log(`  row ${i}:`, r.join(" ")));
    } catch (err: any) {
      setError(err?.message ?? "Failed to read grid");
    } finally {
      setUploadMs(Math.round(performance.now() - t0));
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

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
            <button
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="inline-flex items-center gap-2 rounded-md bg-[#FF69B4] px-3 py-2 text-sm font-semibold text-white hover:bg-[#ff4fa8] active:scale-95 disabled:opacity-50"
            >
              {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              {uploading ? "Reading grid…" : "Upload grid photo"}
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
                if (active === "manual") setManual(EMPTY_GRID);
                else setScanned(EMPTY_GRID);
              }}
              className="rounded-md border border-white/20 bg-white/5 px-3 py-2 text-sm font-medium text-white hover:bg-white/10"
            >
              Clear {active === "manual" ? "manual" : "scanned"}
            </button>
            <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onFile} />
          </div>
          {error && <p className="max-w-md text-center text-sm text-red-400">{error}</p>}
          {uploadMs !== null && !uploading && (
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
            once per word.
          </p>
        </section>

        <section className="min-w-0">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white/70">
              Found words in {active === "manual" ? "Manual" : "Scanned"} grid{" "}
              {solving && <Loader2 className="ml-1 inline h-3 w-3 animate-spin" />}
            </h2>
          </div>
          {!ready && <p className="text-sm text-white/50">Loading English dictionary…</p>}
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
