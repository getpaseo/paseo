export type WorkspaceFilePreviewMode = "default" | "markdown" | "drawio" | "docx" | "spreadsheet";

export function isRenderedMarkdownFile(filePath: string): boolean {
  const normalizedPath = filePath.trim().toLowerCase();
  return normalizedPath.endsWith(".md") || normalizedPath.endsWith(".markdown");
}

export function getWorkspaceFilePreviewMode(filePath: string): WorkspaceFilePreviewMode {
  const normalizedPath = filePath.trim().toLowerCase();
  if (isRenderedMarkdownFile(normalizedPath)) {
    return "markdown";
  }
  if (normalizedPath.endsWith(".drawio") || normalizedPath.endsWith(".drawio.xml")) {
    return "drawio";
  }
  if (normalizedPath.endsWith(".docx")) {
    return "docx";
  }
  if (normalizedPath.endsWith(".xlsx") || normalizedPath.endsWith(".xls")) {
    return "spreadsheet";
  }
  return "default";
}
