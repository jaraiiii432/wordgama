// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, nitro (build-only using cloudflare as a default target),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Build-time word-list validation. Fails the build if the dictionary regresses.
function validateWordListPlugin() {
  const MUST_BE_INVALID = ["rookus", "unsnow", "kongu", "korun", "kurku", "unsnug", "prunus"];
  const MUST_BE_VALID = ["gongs", "snow", "noun", "pour", "sung", "ethanol", "ethanols"];
  return {
    name: "validate-word-list",
    buildStart() {
      const path = resolve(process.cwd(), "public/words.txt");
      const words = new Set(
        readFileSync(path, "utf8")
          .split("\n")
          .map((w) => w.trim().toLowerCase())
          .filter((w) => /^[a-z]+$/.test(w) && w.length >= 3),
      );
      const failures: string[] = [];
      for (const w of MUST_BE_INVALID) if (words.has(w)) failures.push(`"${w}" MUST be invalid but is present in words.txt`);
      for (const w of MUST_BE_VALID) if (!words.has(w)) failures.push(`"${w}" MUST be valid but is missing from words.txt`);
      if (failures.length) {
        this.error(`Word list validation failed:\n  - ${failures.join("\n  - ")}`);
      }
      // eslint-disable-next-line no-console
      console.log(`[validate-word-list] OK — ${MUST_BE_INVALID.length + MUST_BE_VALID.length} assertions passed (${words.size} words loaded)`);
    },
  };
}

export default defineConfig({
  tanstackStart: {
    server: { entry: "server" },
  },
  vite: {
    plugins: [validateWordListPlugin()],
  },
});

