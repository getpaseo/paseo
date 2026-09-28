import { describe, expect, it } from "vitest";
import { parseEvaluatedText } from "./remote-clipboard";

describe("parseEvaluatedText", () => {
  it("returns copied text and ignores empty or non-text results", () => {
    expect(parseEvaluatedText({ command: "evaluate", resultJson: '"codex login"' })).toBe(
      "codex login",
    );
    expect(parseEvaluatedText({ command: "evaluate", resultJson: '""' })).toBeNull();
    expect(parseEvaluatedText({ command: "evaluate", resultJson: "null" })).toBeNull();
    expect(parseEvaluatedText({ command: "click" })).toBeNull();
  });
});
