import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

const InputSchema = z.object({
  imageDataUrl: z.string().min(20),
});

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
        model: "google/gemini-2.5-flash",
        messages: [
          {
            role: "system",
            content:
              "You extract letters from a 4x4 word game grid image. Respond with ONLY 16 uppercase letters A-Z separated by spaces, in reading order (top-left row by row). No punctuation, no explanation.",
          },
          {
            role: "user",
            content: [
              { type: "text", text: "Extract the 16 letters from this 4x4 grid." },
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
    const letters = text
      .toUpperCase()
      .replace(/[^A-Z]/g, "")
      .split("");
    if (letters.length < 16) {
      throw new Error(`Only detected ${letters.length} letters. Try a clearer image.`);
    }
    return { letters: letters.slice(0, 16) };
  });
