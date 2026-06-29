import { isAutoPreviewHtml, resolveFilePreviewKind } from "@/file-explorer/preview-kind";

export function isRenderedMarkdownFile(filePath: string): boolean {
  const normalizedPath = filePath.trim().toLowerCase();
  return normalizedPath.endsWith(".md") || normalizedPath.endsWith(".markdown");
}

export type TextPreviewMode = "markdown" | "html" | "code";

/**
 * Decides how a text file should render in the file pane:
 * - `code`     — syntax-highlighted source (default, and forced when the user
 *                opened a specific line so they can read the exact source).
 * - `markdown` — rendered markdown.
 * - `html`     — live, sandboxed HTML preview ("open an html file and it just
 *                previews"). Falls back to source via the pane's line target.
 *
 * Markdown/HTML detection both go through `resolveFilePreviewKind` so there is a
 * single source of truth for file classification (no parallel classifier to
 * drift). Pure + headlessly testable; the file pane consumes the result.
 */
export function resolveTextPreviewMode(
  filePath: string,
  options?: { hasLineSelection?: boolean },
): TextPreviewMode {
  // A specific line target means the user wants the exact source at that line.
  if (options?.hasLineSelection) {
    return "code";
  }
  const kind = resolveFilePreviewKind(filePath);
  if (kind === "markdown") {
    return "markdown";
  }
  if (isAutoPreviewHtml(filePath)) {
    return "html";
  }
  return "code";
}
