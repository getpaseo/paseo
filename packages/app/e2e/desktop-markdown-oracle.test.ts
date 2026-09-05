import { describe, expect, it } from "vitest";
import {
  buildExpectedMarkdownSource,
  buildMarkdownTextOracle,
  hashMarkdownVisibleText,
  MARKDOWN_WORKLOADS,
} from "./desktop-markdown-oracle";

describe("desktop Markdown benchmark oracle", () => {
  it.each(MARKDOWN_WORKLOADS)("produces an exact-size %s workload", (workload) => {
    const source = buildExpectedMarkdownSource(workload, 4096);
    expect(Buffer.byteLength(source)).toBe(4096);
    expect(buildMarkdownTextOracle(workload, 4096).expectedSourceBytes).toBe(4096);
  });

  it("projects Markdown into visible text instead of accepting source markers", () => {
    const oracle = buildMarkdownTextOracle("mixed_markdown", 256);
    const sourceHash = hashMarkdownVisibleText(buildExpectedMarkdownSource("mixed_markdown", 256));

    expect(oracle.expectedNormalizedTextHash).not.toBe(sourceHash);
    expect(oracle.expectedAnchorCount).toBeGreaterThan(0);
  });

  it("accepts file links in the independent reference parser", () => {
    expect(buildMarkdownTextOracle("link_table_dense", 1024).expectedAnchorCount).toBeGreaterThan(
      1,
    );
  });
});
