export type FilePreviewRenderKind = "markdown" | "html" | "pdf";

export function isRenderedMarkdownFile(filePath: string): boolean {
  const normalizedPath = filePath.trim().toLowerCase();
  return normalizedPath.endsWith(".md") || normalizedPath.endsWith(".markdown");
}

function isRenderedHtmlFile(filePath: string): boolean {
  const normalizedPath = filePath.trim().toLowerCase();
  return normalizedPath.endsWith(".html") || normalizedPath.endsWith(".htm");
}

export function isRenderedPdfFile(filePath: string): boolean {
  return filePath.trim().toLowerCase().endsWith(".pdf");
}

export function filePreviewRenderKind(filePath: string): FilePreviewRenderKind | null {
  if (isRenderedMarkdownFile(filePath)) return "markdown";
  if (isRenderedHtmlFile(filePath)) return "html";
  if (isRenderedPdfFile(filePath)) return "pdf";
  return null;
}
