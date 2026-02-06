import { describe, expect, it } from "vitest";
import { renderAssistantMarkdownHtml } from "./assistant-markdown-html";

describe("renderAssistantMarkdownHtml", () => {
  it("renders tables and lists as HTML", () => {
    const html = renderAssistantMarkdownHtml(
      [
        "- a",
        "- b",
        "",
        "| h1 | h2 |",
        "|---:|:---|",
        "|  1 |  2 |",
      ].join("\n")
    );

    expect(html).toContain("<ul");
    expect(html).toContain("<li");
    expect(html).toContain("<table");
    expect(html).toContain("<thead");
    expect(html).toContain("<tbody");
  });

  it("wraps inline path tokens in a clickable chip", () => {
    const html = renderAssistantMarkdownHtml(
      "Open `src/app.ts:12` and then `not-a-path`."
    );

    expect(html).toContain('data-inline-path="src/app.ts:12"');
    expect(html).toContain('class="paseo-path-chip"');
    expect(html).toContain('class="paseo-inline-code"');
  });

  it("adds safe link attributes", () => {
    const html = renderAssistantMarkdownHtml("Go to https://example.com");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });
});

