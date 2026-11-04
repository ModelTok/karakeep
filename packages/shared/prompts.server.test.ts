import { getEncoding } from "js-tiktoken";
import { describe, expect, test } from "vitest";

import {
  buildDigestPrompt,
  buildSummaryPrompt,
  buildTextPrompt,
} from "./prompts.server";

const enc = getEncoding("o200k_base");
// Same counting as the code under test: special-token look-alikes are plain text.
const tokens = (s: string) => enc.encode(s, [], []).length;

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

  // Pages about tokenizers, or scraped training data, contain the literal text
  // of special tokens. The tokenizer throws on those unless told to count them
  // as ordinary characters, which made tagging and summary jobs fail for good.
  describe("text that looks like a special token", () => {
    const withToken =
      "An article about tokenizers: <|endoftext|> marks the end of a document.";

    test("a summary prompt is still built, with the text kept", async () => {
      const prompt = await buildSummaryPrompt(
        "english",
        [],
        withToken,
        CONTEXT,
      );
      expect(prompt).toContain("<|endoftext|>");
    });

    test("a tagging prompt is still built, with the text kept", async () => {
      const prompt = await buildTextPrompt(
        "english",
        [],
        withToken,
        CONTEXT,
        "as-generated",
      );
      expect(prompt).toContain("<|endoftext|>");
    });

    test("a long page containing it is still cut to fit", async () => {
      const long = `${withToken} `.repeat(2000);
      const prompt = await buildSummaryPrompt("english", [], long, CONTEXT);
      expect(tokens(prompt)).toBeLessThanOrEqual(
        CONTEXT - Math.ceil(CONTEXT * 0.15) + 8,
      );
    });

    test("a digest item containing it does not break the digest prompt", async () => {
      const { prompt, includedCount } = await buildDigestPrompt(
        "english",
        ["[#1] About <|endoftext|> and <|im_start|> (example.com)"],
        200,
        CONTEXT,
      );
      expect(includedCount).toBe(1);
      expect(prompt).toContain("<|endoftext|>");
    });
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
