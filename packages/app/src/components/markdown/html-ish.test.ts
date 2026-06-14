import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { normalizeHtmlishMarkdown, splitHtmlishMarkdown } from "./html-ish";

describe("splitHtmlishMarkdown", () => {
  const inlineImageBody = [
    '<a href="#"><img alt="Priority" src="https://example.com/assets/priority.svg?v=9" align="top"></a> Spoofed browser User-Agent allows access control bypass',
    "",
    "The middleware now trusts any browser-like User-Agent for unauthenticated requests.",
    "",
    "```ts",
    'const isBrowser = userAgent.includes("Mozilla");',
    "```",
  ].join("\n");

  const multiDetailsBody = [
    "### Bot Review",
    "",
    "<details>",
    "<summary><h3>Important Files Changed</h3></summary>",
    "",
    "- `packages/server/src/server/session.ts`",
    "",
    "</details>",
    "",
    "<details>",
    "<summary><h3>Security Findings</h3></summary>",
    "",
    "No blocking findings.",
    "",
    "</details>",
    "",
    "<!-- bot_other_comments_section -->",
    '<sub>Reviews (8): Last reviewed commit: “revert: undo parser” | <a href="https://app.greptile.com">Re-trigger Greptile</a></sub>',
  ].join("\n");

  it("classifies linked HTML images as generic inline images, not block markdown images", () => {
    const [image, text] = splitHtmlishMarkdown(inlineImageBody);

    expect(image).toEqual({
      kind: "inlineImage",
      alt: "Priority",
      src: "https://example.com/assets/priority.svg?v=9",
      flowsWithText: true,
    });
    expect(text).toEqual({
      kind: "markdown",
      text: [
        " Spoofed browser User-Agent allows access control bypass",
        "",
        "The middleware now trusts any browser-like User-Agent for unauthenticated requests.",
        "",
        "```ts",
        'const isBrowser = userAgent.includes("Mozilla");',
        "```",
      ].join("\n"),
    });
  });

  it("flags both images as flowsWithText when two inline images precede title text on the same line", () => {
    const twoImageBody = [
      '<a href="#"><img alt="Priority" src="https://example.com/priority.svg" align="top"></a> <a href="#"><img alt="Security" src="https://example.com/security.svg" align="top"></a> **Title text here**',
      "",
      "Body paragraph.",
    ].join("\n");

    const parts = splitHtmlishMarkdown(twoImageBody);
    const [first, second, third] = parts;

    expect(first).toEqual({
      kind: "inlineImage",
      alt: "Priority",
      src: "https://example.com/priority.svg",
      flowsWithText: true,
    });
    expect(second).toEqual({ kind: "markdown", text: " " });
    expect(third).toEqual({
      kind: "inlineImage",
      alt: "Security",
      src: "https://example.com/security.svg",
      flowsWithText: true,
    });
  });

  it("keeps safe width and height attributes on inline images", () => {
    expect(
      splitHtmlishMarkdown(
        '<img alt="Small" src="https://example.com/small.svg" width="18" height="12">',
      ),
    ).toEqual([
      {
        kind: "inlineImage",
        alt: "Small",
        src: "https://example.com/small.svg",
        width: 18,
        height: 12,
      },
    ]);
  });

  it("keeps safe non-empty image links", () => {
    expect(
      splitHtmlishMarkdown(
        '<a href="https://example.com/details"><img alt="Small" src="https://example.com/small.svg"></a>',
      ),
    ).toEqual([
      {
        kind: "inlineImage",
        alt: "Small",
        src: "https://example.com/small.svg",
        href: "https://example.com/details",
      },
    ]);
  });

  it("preserves inline image parts inside details bodies", () => {
    expect(
      splitHtmlishMarkdown(
        '<details><summary>Images</summary><a href="https://example.com/page"><img alt="Icon" src="https://example.com/icon.svg"></a> Inline text</details>',
      ),
    ).toEqual([
      {
        kind: "details",
        summary: "Images",
        body: "Inline text",
        bodyParts: [
          {
            kind: "inlineImage",
            alt: "Icon",
            src: "https://example.com/icon.svg",
            href: "https://example.com/page",
            flowsWithText: true,
          },
          { kind: "markdown", text: " Inline text" },
        ],
      },
    ]);
  });

  it("does not flag standalone inline images as flowing with text", () => {
    expect(
      splitHtmlishMarkdown('<img alt="Shot" src="https://example.com/shot.png">\n\nCaption below'),
    ).toEqual([
      { kind: "inlineImage", alt: "Shot", src: "https://example.com/shot.png" },
      { kind: "markdown", text: "\n\nCaption below" },
    ]);
  });

  it("does not flag mid-line inline images as flowing with text", () => {
    const [, image] = splitHtmlishMarkdown(
      'Before <img alt="Icon" src="https://example.com/icon.png"> after',
    );

    expect(image).toEqual({
      kind: "inlineImage",
      alt: "Icon",
      src: "https://example.com/icon.png",
    });
  });

  it("leaves ordinary markdown images on the markdown path", () => {
    const source = "![Ordinary](https://example.com/full-size.png)";

    expect(splitHtmlishMarkdown(source)).toEqual([{ kind: "markdown", text: source }]);
  });

  it("leaves unsafe HTML image sources inert", () => {
    const source = '<img alt="Bad" src="javascript:alert(1)">';

    expect(splitHtmlishMarkdown(source)).toEqual([{ kind: "markdown", text: source }]);
  });

  it("removes raw image anchor and image tags from rendered markdown text", () => {
    const text = splitHtmlishMarkdown(inlineImageBody)
      .map((part) => (part.kind === "markdown" ? part.text : ""))
      .join("");

    expect(text).not.toContain("<a ");
    expect(text).not.toContain("<img ");
    expect(text).not.toContain("</a>");
  });

  it("unwraps sub text and strips HTML comments", () => {
    const parts = splitHtmlishMarkdown(multiDetailsBody);
    const tail = parts.at(-1);

    expect(tail).toEqual({
      kind: "markdown",
      text: "\n\nReviews (8): Last reviewed commit: “revert: undo parser” | [Re-trigger Greptile](https://app.greptile.com)",
    });
  });

  it("does not leak stray closing details tags across multiple details blocks", () => {
    const renderedText = splitHtmlishMarkdown(multiDetailsBody)
      .map((part) => {
        if (part.kind === "markdown") return part.text;
        if (part.kind === "details") return `${part.summary}\n${part.body}`;
        return part.alt;
      })
      .join("\n");

    expect(renderedText).not.toContain("</details>");
    expect(renderedText).not.toContain("<!--");
    expect(splitHtmlishMarkdown(multiDetailsBody).slice(0, 4)).toMatchObject([
      { kind: "markdown", text: "### Bot Review\n\n" },
      { kind: "details", summary: "Important Files Changed" },
      { kind: "markdown", text: "\n\n" },
      { kind: "details", summary: "Security Findings" },
    ]);
  });

  it("preserves paragraph boundaries around title, prose, and code block", () => {
    const text = splitHtmlishMarkdown(inlineImageBody)
      .map((part) => (part.kind === "markdown" ? part.text : ""))
      .join("");

    expect(text).toContain(
      "Spoofed browser User-Agent allows access control bypass\n\nThe middleware now trusts",
    );
    expect(text).toContain("unauthenticated requests.\n\n```ts\nconst isBrowser");
  });

  it("keeps product-specific image language out of parser and renderer logic", () => {
    const parserSource = readFileSync(new URL("./html-ish.ts", import.meta.url), "utf8");
    const rendererSource = readFileSync(new URL("./renderer.tsx", import.meta.url), "utf8");
    const productionSource = `${parserSource}\n${rendererSource}`;

    expect(productionSource).not.toMatch(/Greptile|badge|P0|P1|P2|greptile-static-assets/i);
  });

  it("parses Greptile-style details blocks", () => {
    expect(
      splitHtmlishMarkdown(
        "<details><summary><h3>Greptile Summary</h3></summary>Body markdown</details>",
      ),
    ).toEqual([{ kind: "details", summary: "Greptile Summary", body: "Body markdown" }]);
  });

  it("keeps details inside fenced code as literal markdown", () => {
    const source = "```html\n<details><summary>Example</summary>Body</details>\n```";

    expect(splitHtmlishMarkdown(source)).toEqual([{ kind: "markdown", text: source }]);
  });

  it("keeps details inside inline code on native runtimes without copied array sorting", () => {
    const source = "Use `<details><summary>Example</summary>Body</details>` as an example.";

    expect(withoutArrayToSorted(() => splitHtmlishMarkdown(source))).toEqual([
      { kind: "markdown", text: source },
    ]);
  });

  it("keeps details inside inline code as literal markdown", () => {
    const source = "Use `<details><summary>Example</summary>Body</details>` as an example.";

    expect(splitHtmlishMarkdown(source)).toEqual([{ kind: "markdown", text: source }]);
  });

  it("still parses normal details outside code", () => {
    expect(splitHtmlishMarkdown("`code`\n<details><summary>Real</summary>Body</details>")).toEqual([
      { kind: "markdown", text: "`code`\n" },
      { kind: "details", summary: "Real", body: "Body" },
    ]);
  });

  it("preserves text before and after details blocks", () => {
    expect(
      splitHtmlishMarkdown("Before\n<details><summary>More</summary>Hidden</details>\nAfter"),
    ).toEqual([
      { kind: "markdown", text: "Before\n" },
      { kind: "details", summary: "More", body: "Hidden" },
      { kind: "markdown", text: "\nAfter" },
    ]);
  });

  it("parses multiple details blocks", () => {
    expect(
      splitHtmlishMarkdown(
        "<details><summary>One</summary>A</details><details><summary>Two</summary>B</details>",
      ),
    ).toEqual([
      { kind: "details", summary: "One", body: "A" },
      { kind: "details", summary: "Two", body: "B" },
    ]);
  });

  it("normalizes br and simple code tags into markdown", () => {
    expect(normalizeHtmlishMarkdown("Line 1<br/>Line 2 <code>safe-value</code>")).toBe(
      "Line 1\nLine 2 `safe-value`",
    );
  });

  it("leaves complex code tags inert instead of parsing HTML", () => {
    expect(normalizeHtmlishMarkdown('<code onclick="evil()"><script>x</script></code>')).toBe(
      '<code onclick="evil()"><script>x</script></code>',
    );
  });

  it("falls back to inert markdown when details are unclosed", () => {
    const source = "<details><summary>Open</summary>Still open";

    expect(splitHtmlishMarkdown(source)).toEqual([{ kind: "markdown", text: source }]);
  });

  it("falls back to inert markdown when summary is missing", () => {
    const source = "<details>Hidden</details>";

    expect(splitHtmlishMarkdown(source)).toEqual([{ kind: "markdown", text: source }]);
  });

  it("does not execute or render unknown HTML as structured content", () => {
    const source =
      '<script>alert(1)</script><details onclick="evil()"><summary>Safe</summary><iframe src="x"></iframe></details>';

    expect(splitHtmlishMarkdown(source)).toEqual([
      { kind: "markdown", text: "<script>alert(1)</script>" },
      { kind: "details", summary: "Safe", body: '<iframe src="x"></iframe>' },
    ]);
  });
});

function withoutArrayToSorted<T>(callback: () => T): T {
  const descriptor = Object.getOwnPropertyDescriptor(Array.prototype, "toSorted");
  Reflect.deleteProperty(Array.prototype, "toSorted");
  try {
    return callback();
  } finally {
    if (descriptor) {
      Reflect.defineProperty(Array.prototype, "toSorted", descriptor);
    }
  }
}
