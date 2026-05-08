import { describe, expect, it } from "vitest";
import {
  getWorkspaceFilePreviewMode,
  isRenderedMarkdownFile,
} from "@/components/file-pane-render-mode";

describe("isRenderedMarkdownFile", () => {
  it("detects .md files", () => {
    expect(isRenderedMarkdownFile("README.md")).toBe(true);
    expect(isRenderedMarkdownFile("docs/guide.MD")).toBe(true);
  });

  it("detects .markdown files", () => {
    expect(isRenderedMarkdownFile("notes.markdown")).toBe(true);
    expect(isRenderedMarkdownFile("docs/CHANGELOG.MARKDOWN")).toBe(true);
  });

  it("does not treat .mdx files as rendered markdown", () => {
    expect(isRenderedMarkdownFile("page.mdx")).toBe(false);
  });

  it("does not treat other text files as rendered markdown", () => {
    expect(isRenderedMarkdownFile("src/index.ts")).toBe(false);
    expect(isRenderedMarkdownFile("README.md.txt")).toBe(false);
  });
});

describe("getWorkspaceFilePreviewMode", () => {
  it("routes draw.io diagrams to the drawio preview", () => {
    expect(getWorkspaceFilePreviewMode("architecture.drawio")).toBe("drawio");
    expect(getWorkspaceFilePreviewMode("docs/flow.DRAWIO.XML")).toBe("drawio");
  });

  it("routes Office documents to local read-only previews", () => {
    expect(getWorkspaceFilePreviewMode("notes.docx")).toBe("docx");
    expect(getWorkspaceFilePreviewMode("reports/plan.XLSX")).toBe("spreadsheet");
    expect(getWorkspaceFilePreviewMode("reports/legacy.xls")).toBe("spreadsheet");
  });

  it("preserves existing markdown and default routing", () => {
    expect(getWorkspaceFilePreviewMode("README.md")).toBe("markdown");
    expect(getWorkspaceFilePreviewMode("src/index.ts")).toBe("default");
  });
});
