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

function randomGrid(): string[] {
  const dice = "AAAAAABBCCDDEEEEEEFFGGHHIIIIJKLLMMNNNNOOOOPPQRRRSSSSTTTTUUVVWWXYYZ";
  return Array.from({ length: 16 }, () => dice[Math.floor(Math.random() * dice.length)]);
}

function WordAssistant() {
  const [letters, setLetters] = useState<string[]>(DEFAULT_GRID);
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

  const grid = useMemo(() => letters.map((c) => (c || " ").toLowerCase()), [letters]);

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

  function setCell(i: number, v: string) {
    const ch = v.slice(-1).toUpperCase();
    if (ch && !/[A-Z]/.test(ch)) return;
    setLetters((prev) => {
      const n = [...prev];
      n[i] = ch;
      return n;
    });
    if (ch) {
      const next = document.querySelector<HTMLInputElement>(`input[data-cell="${i + 1}"]`);
      next?.focus();
    }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    setUploading(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as string);
        r.onerror = () => reject(r.error);
        r.readAsDataURL(file);
      });
      const { letters: got } = await extract({ data: { imageDataUrl: dataUrl } });
      setLetters(got);
    } catch (err: any) {
      setError(err?.message ?? "Failed to read grid");
    } finally {
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

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-5">
          <div className="flex items-center gap-2">
            <div className="grid h-8 w-8 place-items-center rounded-md bg-primary text-primary-foreground">
              <Sparkles className="h-4 w-4" />
            </div>
            <h1 className="text-lg font-semibold tracking-tight">Grid Word Assistant</h1>
          </div>
          <div className="text-xs text-muted-foreground">
            {ready ? `${results.length.toLocaleString()} words` : "Loading dictionary…"}
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-5xl gap-8 px-4 py-8 md:grid-cols-[auto_1fr]">
        <section className="flex flex-col items-center gap-4">
          <div
            className="grid gap-2"
            style={{ gridTemplateColumns: "repeat(4, minmax(0, 1fr))" }}
          >
            {letters.map((c, i) => {
              const highlighted = hovered?.cells.includes(i);
              const order = hovered ? hovered.cells.indexOf(i) : -1;
              return (
                <div key={i} className="relative">
                  <input
                    data-cell={i}
                    value={c}
                    maxLength={1}
                    onChange={(e) => setCell(i, e.target.value)}
                    onFocus={(e) => e.target.select()}
                    className={[
                      "h-16 w-16 rounded-lg border text-center text-2xl font-bold uppercase transition-all sm:h-20 sm:w-20 sm:text-3xl",
                      "focus:outline-none focus:ring-2 focus:ring-primary",
                      highlighted
                        ? "border-primary bg-primary text-primary-foreground shadow-lg scale-105"
                        : "border-border bg-card text-card-foreground hover:border-primary/50",
                    ].join(" ")}
                  />
                  {highlighted && order >= 0 && (
                    <span className="pointer-events-none absolute right-1 top-1 rounded-full bg-background/90 px-1.5 text-[10px] font-semibold text-primary">
                      {order + 1}
                    </span>
                  )}
                </div>
              );
            })}
          </div>

          <div className="flex flex-wrap justify-center gap-2">
            <button
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="inline-flex items-center gap-2 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {uploading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Upload className="h-4 w-4" />
              )}
              {uploading ? "Reading grid…" : "Upload grid photo"}
            </button>
            <button
              onClick={() => setLetters(randomGrid())}
              className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-accent"
            >
              <Shuffle className="h-4 w-4" /> Random
            </button>
            <button
              onClick={() => setLetters(Array(16).fill(""))}
              className="rounded-md border border-border bg-card px-3 py-2 text-sm font-medium hover:bg-accent"
            >
              Clear
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={onFile}
            />
          </div>
          {error && (
            <p className="max-w-xs text-center text-sm text-destructive">{error}</p>
          )}
          <p className="max-w-xs text-center text-xs text-muted-foreground">
            Letters connect in all 8 directions (up, down, left, right, diagonals). Each
            tile is used once per word.
          </p>
        </section>

        <section className="min-w-0">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-muted-foreground">
              Found words {solving && <Loader2 className="ml-1 inline h-3 w-3 animate-spin" />}
            </h2>
          </div>
          {!ready && (
            <p className="text-sm text-muted-foreground">Loading English dictionary…</p>
          )}
          {ready && results.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Fill every cell to see valid words.
            </p>
          )}
          <div className="space-y-4">
            {grouped.map(([len, words]) => (
              <div key={len}>
                <div className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
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
                      className="rounded-md border border-border bg-card px-2 py-1 text-sm font-medium capitalize transition-colors hover:border-primary hover:bg-accent"
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
