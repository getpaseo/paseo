import { createHash } from "node:crypto";
import { DomUtils, parseDocument } from "htmlparser2";
import MarkdownIt from "markdown-it";

export const MARKDOWN_ORACLE_RELEASE = "desktop_markdown_visible_text@v1";

export const MARKDOWN_WORKLOADS = [
  "plain_unbroken",
  "prose_blocks",
  "open_typescript_fence",
  "closed_typescript_fences",
  "mixed_markdown",
  "link_table_dense",
] as const;

export type MarkdownWorkload = (typeof MARKDOWN_WORKLOADS)[number];

export interface MarkdownTextOracle {
  release: typeof MARKDOWN_ORACLE_RELEASE;
  expectedSourceBytes: number;
  expectedNormalizedText: string;
  expectedNormalizedTextChars: number;
  expectedNormalizedTextHash: string;
  expectedAnchorCount: number;
}

function repeatPattern(pattern: string, bytes: number): string {
  const repeats = Math.floor(bytes / pattern.length);
  const remainder = bytes - repeats * pattern.length;
  return `${pattern.repeat(repeats)}${"x".repeat(remainder)}`;
}

// This is intentionally independent of the mock provider implementation. It is the frozen
// benchmark workload specification: if the provider or renderer changes visible output, the
// benchmark fails instead of silently publishing faster numbers for different content.
export function buildExpectedMarkdownSource(workload: MarkdownWorkload, bytes: number): string {
  switch (workload) {
    case "plain_unbroken":
      return "x".repeat(bytes);
    case "prose_blocks":
      return repeatPattern(
        "Benchmark paragraph with stable words and deterministic wrapping behavior.\n\n",
        bytes,
      );
    case "open_typescript_fence": {
      const prefix = "```ts\n";
      if (bytes <= prefix.length) return prefix.slice(0, bytes);
      return `${prefix}${repeatPattern("const value = source.map((item) => item.id);\n", bytes - prefix.length)}`;
    }
    case "closed_typescript_fences":
      return repeatPattern("```ts\nconst value = 42;\nconsole.log(value);\n```\n\n", bytes);
    case "mixed_markdown":
      return repeatPattern(
        "## Benchmark section\n\nParagraph with **bold**, _emphasis_, and [a link](https://example.com).\n\n- first item\n- second item\n\n| name | value |\n| --- | ---: |\n| alpha | 42 |\n\n```ts\nconst alpha = 42;\n```\n\n",
        bytes,
      );
    case "link_table_dense":
      return repeatPattern(
        "| name | value | link |\n| --- | ---: | --- |\n| alpha | 42 | [details](https://example.com/alpha) |\n| beta | 84 | [source](file:///tmp/source.ts) |\n\n",
        bytes,
      );
  }
}

export function normalizeMarkdownVisibleText(text: string): string {
  // RN Web emits adjacent block and table-cell text without DOM whitespace, while semantic HTML
  // includes separator whitespace. Ignore that layout-only difference but retain every non-space
  // character so missing content or leaked Markdown syntax still fails the oracle.
  return text.replace(/[•◦▪\s]+/gu, "");
}

export function hashMarkdownVisibleText(text: string): string {
  return createHash("sha256").update(normalizeMarkdownVisibleText(text)).digest("hex");
}

export function buildMarkdownTextOracle(
  workload: MarkdownWorkload,
  bytes: number,
): MarkdownTextOracle {
  const source = buildExpectedMarkdownSource(workload, bytes);
  const parser = new MarkdownIt({ typographer: true, linkify: true });
  const defaultValidateLink = parser.validateLink.bind(parser);
  parser.validateLink = (url: string) =>
    url.trim().toLowerCase().startsWith("file://") || defaultValidateLink(url);
  const document = parseDocument(parser.render(source));
  const expectedVisibleText = normalizeMarkdownVisibleText(DomUtils.textContent(document));
  const expectedAnchorCount = DomUtils.findAll(
    (element) => element.name === "a",
    document.children,
  ).length;
  return {
    release: MARKDOWN_ORACLE_RELEASE,
    expectedSourceBytes: Buffer.byteLength(source),
    expectedNormalizedText: expectedVisibleText,
    expectedNormalizedTextChars: expectedVisibleText.length,
    expectedNormalizedTextHash: hashMarkdownVisibleText(expectedVisibleText),
    expectedAnchorCount,
  };
}
