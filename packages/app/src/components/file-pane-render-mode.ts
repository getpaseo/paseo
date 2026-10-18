export type FilePreviewRenderKind = "markdown" | "markdown-too-large" | "html";

export function isRenderedMarkdownFile(filePath: string): boolean {
  const normalizedPath = filePath.trim().toLowerCase();
  return normalizedPath.endsWith(".md") || normalizedPath.endsWith(".markdown");
}

function isRenderedHtmlFile(filePath: string): boolean {
  const normalizedPath = filePath.trim().toLowerCase();
  return normalizedPath.endsWith(".html") || normalizedPath.endsWith(".htm");
}

// The Markdown renderer mounts the complete native tree. Bound this work before
// parsing, including when a persisted file tab is restored on startup.
const MAX_MARKDOWN_PREVIEW_CODE_UNITS = 64 * 1024;
const MAX_MARKDOWN_PREVIEW_LINES = 1000;

function exceedsMarkdownPreviewBudget(source: string): boolean {
  if (source.length > MAX_MARKDOWN_PREVIEW_CODE_UNITS) return true;
  let lines = 1;
  for (let index = 0; index < source.length; index++) {
    const code = source.charCodeAt(index);
    if (code !== 10 && code !== 13) continue;
    if (++lines > MAX_MARKDOWN_PREVIEW_LINES) return true;
    if (code === 13 && source.charCodeAt(index + 1) === 10) index++;
  }
  return false;
}

export function filePreviewRenderKind(
  filePath: string,
  source?: string,
): FilePreviewRenderKind | null {
  if (isRenderedMarkdownFile(filePath)) {
    return source !== undefined && exceedsMarkdownPreviewBudget(source)
      ? "markdown-too-large"
      : "markdown";
  }
  if (isRenderedHtmlFile(filePath)) return "html";
  return null;
}
