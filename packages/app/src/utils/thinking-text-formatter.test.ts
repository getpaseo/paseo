import { describe, expect, it } from "vitest";
import { formatThinkingText } from "./thinking-text-formatter";

describe("formatThinkingText", () => {
  it("handles empty or invalid inputs", () => {
    expect(formatThinkingText("")).toBe("");
    expect(formatThinkingText(null as unknown as string)).toBe("");
    expect(formatThinkingText(undefined as unknown as string)).toBe("");
  });

  it("separates adjacent bold titles without newlines", () => {
    expect(formatThinkingText("**title****title2**")).toBe("**title**\n\n**title2**");
    expect(formatThinkingText("**title1****title2****title3**")).toBe(
      "**title1**\n\n**title2**\n\n**title3**",
    );
  });

  it("separates adjacent bold titles separated only by spaces", () => {
    expect(formatThinkingText("**title1** **title2**")).toBe("**title1**\n\n**title2**");
    expect(formatThinkingText("**title1**   **title2**")).toBe("**title1**\n\n**title2**");
  });

  it("separates numbered headers", () => {
    expect(formatThinkingText("**1. Analyze goal****2. Execute plan**")).toBe(
      "**1. Analyze goal**\n\n**2. Execute plan**",
    );
  });

  it("handles in-progress streaming where second bold tag is opened", () => {
    expect(formatThinkingText("**title1****title2")).toBe("**title1**\n\n**title2");
    expect(formatThinkingText("**title1****")).toBe("**title1**\n\n**");
  });

  it("preserves regular markdown bold within prose without altering intended formatting", () => {
    const prose = "This function uses **foo** and **bar** as arguments.";
    expect(formatThinkingText(prose)).toBe(prose);

    const uppercaseProse = "I need to inspect **AgentStreamView** before editing it.";
    expect(formatThinkingText(uppercaseProse)).toBe(uppercaseProse);

    const afterPunctuation =
      'I looked at config.json, which had key "version". **Note** that this is deprecated.';
    expect(formatThinkingText(afterPunctuation)).toBe(afterPunctuation);
  });

  it("preserves fenced code blocks and inline code completely intact", () => {
    const codeWithBold = "```python\ndef foo():\n\n\n    # check **a****b**\n```";
    expect(formatThinkingText(codeWithBold)).toBe(codeWithBold);

    const inlineCode = "Use `**bold**` inside inline code.";
    expect(formatThinkingText(inlineCode)).toBe(inlineCode);

    const streamingCodeBlock = "```typescript\nconst x = **test**;\n";
    expect(formatThinkingText(streamingCodeBlock)).toBe(streamingCodeBlock);
  });

  it("preserves already well-spaced thinking blocks without adding excess newlines", () => {
    const wellSpaced = "**Title 1**\n\nSome thought text.\n\n**Title 2**\n\nMore thought text.";
    expect(formatThinkingText(wellSpaced)).toBe(wellSpaced);
  });
});
