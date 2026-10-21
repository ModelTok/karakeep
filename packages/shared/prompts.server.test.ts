import { getEncoding } from "js-tiktoken";
import { describe, expect, test } from "vitest";

import { buildSummaryPrompt, buildTextPrompt } from "./prompts.server";

const enc = getEncoding("o200k_base");
const tokens = (s: string) => enc.encode(s).length;

const CONTEXT = 4096;
// A page far longer than the context, as most real articles are.
const longPage =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(4000);

describe("prompt sizing", () => {
  // Filling the context to the brim leaves nothing for the reply, and any
  // difference in how the model counts tokens overflows it. Ollama then drops
  // the start of the prompt, which is where the instructions are.
  const headroom = Math.ceil(CONTEXT * 0.15);

  test("a summary prompt leaves room for the reply", async () => {
    const prompt = await buildSummaryPrompt("english", [], longPage, CONTEXT);
    expect(tokens(prompt)).toBeLessThanOrEqual(CONTEXT - headroom + 8);
    expect(prompt).toContain("Summarize the following content");
  });

  test("a tagging prompt leaves room for the reply", async () => {
    const prompt = await buildTextPrompt(
      "english",
      [],
      longPage,
      CONTEXT,
      "as-generated",
    );
    expect(tokens(prompt)).toBeLessThanOrEqual(CONTEXT - headroom + 8);
    expect(prompt).toContain("Aim for 3-5 tags");
  });

  test("short content is passed through untouched", async () => {
    const prompt = await buildSummaryPrompt(
      "english",
      [],
      "A short note.",
      CONTEXT,
    );
    expect(prompt).toContain("A short note.");
  });
});
