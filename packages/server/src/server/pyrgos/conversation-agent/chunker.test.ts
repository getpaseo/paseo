import { describe, expect, it } from "vitest";
import { cleanMarkdown } from "./chunker.js";

describe("cleanMarkdown", () => {
  it("drops emphasis, code and heading marks", () => {
    expect(cleanMarkdown("**bold** and `code` and _it_")).toBe("bold and code and it");
    expect(cleanMarkdown("# Title\n> quote")).toBe(" Title\n quote");
  });

  it("keeps underscores and asterisks inside identifiers and arithmetic", () => {
    expect(cleanMarkdown("set VOICE_LAB_HOST to snake_case, 2*3")).toBe(
      "set VOICE_LAB_HOST to snake_case, 2*3",
    );
  });
});
