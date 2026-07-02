import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const InputSchema = z.object({
  imageDataUrl: z.string().min(20),
});

/**
 * Returns letters as a 4x4 grid ordered by ROW then COLUMN, matching the
 * spatial layout of the source image (row 0 = top row, col 0 = left).
 * Response shape: { rows: string[][] } where rows.length === 4 and each row has 4 letters.
 */
export const extractGrid = createServerFn({ method: "POST" })
  .inputValidator((data) => InputSchema.parse(data))
  .handler(async ({ data }) => {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey) throw new Error("LOVABLE_API_KEY missing");

    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash-lite",
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              'You extract letters from a 4x4 word-game grid image. Analyze the letter positions SPATIALLY. Return ONLY JSON of the exact form {"rows":[["A","B","C","D"],["E","F","G","H"],["I","J","K","L"],["M","N","O","P"]]}. rows[0] is the TOP row of the image left-to-right, rows[1] is the second row from the top, etc. Every entry is one uppercase A-Z letter. No prose.',
          },
          {
            role: "user",
            content: [
              { type: "text", text: "Extract the 4x4 grid as JSON." },
              { type: "image_url", image_url: { url: data.imageDataUrl } },
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      const t = await res.text();
      throw new Error(`AI gateway ${res.status}: ${t.slice(0, 200)}`);
    }
    const json = await res.json();
    const text: string = json.choices?.[0]?.message?.content ?? "";

    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) throw new Error("Model did not return JSON");
      parsed = JSON.parse(m[0]);
    }

    const rows = parsed?.rows;
    if (!Array.isArray(rows) || rows.length !== 4) {
      throw new Error("Expected 4 rows in response");
    }
    const clean: string[][] = rows.map((r: any, i: number) => {
      if (!Array.isArray(r) || r.length !== 4) {
        throw new Error(`Row ${i} does not have 4 letters`);
      }
      return r.map((c: any) => String(c).toUpperCase().replace(/[^A-Z]/g, "").slice(0, 1) || "?");
    });

    // Flat, row-major (row 0 left-to-right, then row 1, ...) for the UI's 16-cell array.
    const letters: string[] = clean.flat();
    return { rows: clean, letters };
  });
