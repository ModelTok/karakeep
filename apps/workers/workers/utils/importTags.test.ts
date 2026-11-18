import { describe, expect, it } from "vitest";

import { cleanImportTags } from "./importTags";

describe("cleanImportTags", () => {
  it("keeps ordinary tags in order", () => {
    expect(cleanImportTags(["ai", "rust", "news"])).toEqual([
      "ai",
      "rust",
      "news",
    ]);
  });

  it("drops empty and whitespace-only tags", () => {
    expect(cleanImportTags(["ai", "", "   ", "\t", "rust"])).toEqual([
      "ai",
      "rust",
    ]);
  });

  it("trims surrounding whitespace", () => {
    expect(cleanImportTags(["  ai ", "rust\n"])).toEqual(["ai", "rust"]);
  });

  it("drops repeats, including ones that differ only by whitespace", () => {
    expect(cleanImportTags(["ai", " ai", "ai ", "rust", "ai"])).toEqual([
      "ai",
      "rust",
    ]);
  });

  it("copes with missing input and null entries", () => {
    expect(cleanImportTags(null)).toEqual([]);
    expect(cleanImportTags(undefined)).toEqual([]);
    expect(cleanImportTags([null, undefined, "ai"])).toEqual(["ai"]);
  });

  it("returns nothing when every tag is blank", () => {
    expect(cleanImportTags(["", " "])).toEqual([]);
  });
});
