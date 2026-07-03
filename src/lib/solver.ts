// 4x4 Boggle-style solver. Adjacency = 8 neighbors (up/down/left/right + diagonals).
// Each cell used at most once per word.

type TrieNode = {
  children: Map<string, TrieNode>;
  word?: string;
};

export type DictionaryTrie = TrieNode;

export function normalizeWord(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z]/g, "");
}

export function isValidDictionaryWord(raw: string, trie: TrieNode): boolean {
  const word = normalizeWord(raw);
  if (word.length < 3) return false;

  let node: TrieNode | undefined = trie;
  for (const ch of word) {
    node = node.children.get(ch);
    if (!node) return false;
  }

  return node.word === word;
}

export function filterValidPaths(paths: Path[], trie: TrieNode): Path[] {
  return paths.filter((path) => isValidDictionaryWord(path.word, trie));
}

export function buildTrie(words: string[]): TrieNode {
  const root: TrieNode = { children: new Map() };
  for (const raw of words) {
    const w = normalizeWord(raw);
    if (w.length < 3) continue;
    let node = root;
    for (const ch of w) {
      let next = node.children.get(ch);
      if (!next) {
        next = { children: new Map() };
        node.children.set(ch, next);
      }
      node = next;
    }
    node.word = w;
  }
  return root;
}

const NEIGHBORS: [number, number][] = [
  [-1, -1], [-1, 0], [-1, 1],
  [0, -1],           [0, 1],
  [1, -1],  [1, 0],  [1, 1],
];

export type Path = { word: string; cells: number[] };

export function solve(grid: string[], trie: TrieNode): Path[] {
  // grid: 16 letters lowercase
  const size = 4;
  const found = new Map<string, number[]>();
  const used = new Array(16).fill(false);

  function dfs(r: number, c: number, node: TrieNode, path: number[]) {
    const idx = r * size + c;
    const ch = grid[idx];
    const next = node.children.get(ch);
    if (!next) return;
    path.push(idx);
    used[idx] = true;
    if (next.word && isValidDictionaryWord(next.word, trie) && !found.has(next.word)) {
      found.set(next.word, [...path]);
    }
    for (const [dr, dc] of NEIGHBORS) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr >= size || nc < 0 || nc >= size) continue;
      const ni = nr * size + nc;
      if (used[ni]) continue;
      dfs(nr, nc, next, path);
    }
    used[idx] = false;
    path.pop();
  }

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      dfs(r, c, trie, []);
    }
  }

  return Array.from(found.entries())
    .map(([word, cells]) => ({ word, cells }))
    .sort((a, b) => b.word.length - a.word.length || a.word.localeCompare(b.word));
}

let _trie: TrieNode | null = null;
let _loading: Promise<TrieNode> | null = null;

export function loadTrie(): Promise<TrieNode> {
  if (_trie) return Promise.resolve(_trie);
  if (_loading) return _loading;
  _loading = fetch("/words.txt")
    .then((r) => r.text())
    .then((txt) => {
      const words = txt.split("\n");
      _trie = buildTrie(words);
      return _trie;
    });
  return _loading;
}
