import { describe, expect, test } from "vitest";

import { extractUserMessageText } from "./claude-agent.js";

describe("extractUserMessageText", () => {
  test("returns trimmed string content", () => {
    expect(extractUserMessageText("  Hello world  ")).toBe("Hello world");
  });

  test("combines multiple text blocks", () => {
    const content = [
      { type: "text", text: "First line" },
      { type: "text", text: "Second line" },
    ];

    expect(extractUserMessageText(content)).toBe("First line\n\nSecond line");
  });

  test("returns null when no textual content is present", () => {
    const content = [
      { type: "image", source: "foo.png" },
      { type: "file", path: "bar.txt" },
    ];

    expect(extractUserMessageText(content)).toBeNull();
  });
});
