import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { describe, expect, it } from "vitest";
import { parseHeadings } from "~/docs";
import { docsRehypePlugins, docsRemarkPlugins } from "~/docs-rehype";

function render(markdown: string): string {
  return renderToStaticMarkup(
    createElement(
      ReactMarkdown,
      { remarkPlugins: docsRemarkPlugins, rehypePlugins: docsRehypePlugins("链接到本节") },
      markdown,
    ),
  );
}

const TRANSLATED = [
  "## 安装 {#install}",
  "",
  "### 运行 `paseo run` {#paseo-run}",
  "",
  "## 配置",
  "",
  ":::example[回复 Slack 提及 {#answer-a-slack-mention}]",
  "正文",
  ":::",
].join("\n");

describe("{#id} anchors", () => {
  it("pin heading ids and leave no literal syntax in the page", () => {
    const html = render(TRANSLATED);

    expect(html).toContain('<h2 id="install">');
    expect(html).toContain('<h3 id="paseo-run">');
    expect(html).toContain("<code>paseo run</code>");
    expect(html).toContain('<h2 id="配置">');
    expect(html).toContain('<details class="docs-example" id="answer-a-slack-mention">');
    expect(html).toContain('<summary class="docs-example-summary">回复 Slack 提及</summary>');
    expect(html).not.toContain("{#");
  });

  it("give the outline the same ids the page renders", () => {
    expect(parseHeadings(TRANSLATED)).toEqual([
      { depth: 2, text: "安装", id: "install" },
      { depth: 3, text: "运行 paseo run", id: "paseo-run" },
      { depth: 2, text: "配置", id: "配置" },
    ]);
  });

  it("leave English headings to the slugger", () => {
    expect(render("## Install the CLI")).toContain('<h2 id="install-the-cli">');
  });
});
