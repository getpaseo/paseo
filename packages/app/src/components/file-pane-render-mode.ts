export type FilePreviewRenderKind = "markdown" | "html";

export function isRenderedMarkdownFile(filePath: string): boolean {
  const normalizedPath = filePath.trim().toLowerCase();
  return normalizedPath.endsWith(".md") || normalizedPath.endsWith(".markdown");
}

function isRenderedHtmlFile(filePath: string): boolean {
  const normalizedPath = filePath.trim().toLowerCase();
  return normalizedPath.endsWith(".html") || normalizedPath.endsWith(".htm");
}

export function filePreviewRenderKind(filePath: string): FilePreviewRenderKind | null {
  if (isRenderedMarkdownFile(filePath)) return "markdown";
  if (isRenderedHtmlFile(filePath)) return "html";
  return null;
}
