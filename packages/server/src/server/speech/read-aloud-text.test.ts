import { describe, expect, it } from "vitest";

import { hasSpeakableContent, sanitizeTextForReadAloud } from "./read-aloud-text.js";

describe("sanitizeTextForReadAloud", () => {
  it("drops Paseo's spoken-input wrapper and speaks only the message", () => {
    const selection = [
      "<spoken-input>",
      "Are you working?",
      "</spoken-input>",
      "<instruction>This message was spoken by the user.</instruction>",
    ].join("\n");

    expect(sanitizeTextForReadAloud(selection)).toBe(
      "Are you working? This message was spoken by the user.",
    );
  });

  it("keeps comparisons that are not tags", () => {
    expect(sanitizeTextForReadAloud("if a < b and c > d")).toBe("if a < b and c > d");
  });

  it("strips markdown emphasis and heading markers but keeps the words", () => {
    expect(sanitizeTextForReadAloud("## The **bold** and _quiet_ `code` part")).toBe(
      "The bold and quiet code part",
    );
  });

  it("speaks a link's label, not its URL", () => {
    expect(sanitizeTextForReadAloud("See [the docs](https://example.com/a/b) for more")).toBe(
      "See the docs for more",
    );
  });

  it("drops code fences while keeping the code inside", () => {
    const selection = ["Run this:", "```bash", "npm run dev", "```"].join("\n");
    expect(sanitizeTextForReadAloud(selection)).toBe("Run this: npm run dev");
  });

  it("strips list bullets and numbering", () => {
    expect(sanitizeTextForReadAloud("- first\n- second\n1. third")).toBe("first second third");
  });

  it("collapses a markup-only selection to nothing", () => {
    expect(sanitizeTextForReadAloud("<spoken-input>\n</spoken-input>")).toBe("");
  });
});

describe("hasSpeakableContent", () => {
  it("accepts anything containing a letter or digit", () => {
    expect(hasSpeakableContent("hi")).toBe(true);
    expect(hasSpeakableContent("42")).toBe(true);
    expect(hasSpeakableContent("こんにちは")).toBe(true);
  });

  it("rejects punctuation-only fragments that would synthesize to silence", () => {
    expect(hasSpeakableContent("--- ...")).toBe(false);
    expect(hasSpeakableContent("")).toBe(false);
  });
});
