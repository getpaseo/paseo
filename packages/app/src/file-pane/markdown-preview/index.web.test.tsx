import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownPreviewDocument } from "./index.web";

function render(source: string): string {
  return renderToStaticMarkup(<MarkdownPreviewDocument source={source} contentFontSize={16} />);
}

describe("MarkdownPreviewDocument", () => {
  it("renders front matter as a table before the body", () => {
    const html = render("---\ntitle: Hello\ntags: a, b\n---\n\n# Body\n");

    expect(html).toContain("paseo-md-frontmatter");
    expect(html).toContain(">title<");
    expect(html).toContain(">Hello<");
    expect(html).toContain(">tags<");
    expect(html).toContain(">a, b<");
    expect(html).not.toContain("title: Hello");
    expect(html).toContain(">Body<");
  });

  it("renders GFM tables inside a horizontal scroll wrapper", () => {
    const html = render("| a | b |\n| --- | --- |\n| 1 | 2 |\n");

    expect(html).toContain('class="paseo-md-table-scroll"');
    expect(html).toContain("<table>");
    expect(html).toContain("<th>a</th>");
    expect(html).toContain("<td>1</td>");
  });

  it("renders GFM task lists as checkboxes", () => {
    const html = render("- [x] done\n- [ ] todo\n");

    expect(html).toContain('type="checkbox"');
    expect(html).toContain("checked");
    expect(html).toContain("contains-task-list");
  });

  it("highlights fenced code with the shared syntax tokens", () => {
    const html = render("```ts\nconst answer = 42;\n```\n");

    expect(html).toContain('data-pmono=""');
    expect(html).toContain('class="paseo-md-tok-keyword"');
    expect(html).toContain("const");
    expect(html).toContain("42");
  });

  it("leaves unsupported languages as plain text", () => {
    const html = render("```madeup\nnot highlighted\n```\n");

    expect(html).toContain("not highlighted");
    expect(html).not.toContain("paseo-md-tok-");
  });

  it("adds slugged heading anchors and GFM strikethrough", () => {
    const html = render("## Some Heading\n\n~~gone~~\n");

    expect(html).toContain('id="some-heading"');
    expect(html).toContain('class="paseo-md-anchor"');
    expect(html).toContain("<del>gone</del>");
  });
});
