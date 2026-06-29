/**
 * Decides how a file should be previewed in the file pane, based on its path
 * (extension). This is the pure, headlessly-testable core of the "HTML files
 * auto-preview" feature: the file pane renders `html` in a sandboxed webview
 * instead of showing raw source. All other kinds keep their existing rendering
 * (image viewer, markdown, syntax-highlighted text).
 *
 * Classification is kept consistent with the server's own file-kind detection
 * (`.svg` is served as an image), so this never claims a render path the file
 * pane can't actually reach.
 */
export type FilePreviewKind = "html" | "image" | "markdown" | "pdf" | "text";

const HTML_EXTENSIONS = new Set(["html", "htm", "xhtml"]);
const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"]);
const PDF_EXTENSIONS = new Set(["pdf"]);
const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "ico",
  "avif",
  "apng",
  // The server serves SVG as an image too; keep this classifier aligned.
  "svg",
]);

/**
 * Returns the lowercased file extension (without the dot) for a path. Ignores
 * leading-dot "dotfiles" (e.g. `.gitignore` has no preview extension).
 */
export function getFileExtension(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const dotIndex = base.lastIndexOf(".");
  if (dotIndex <= 0) {
    // No dot, or a leading-dot dotfile with no further extension.
    return "";
  }
  return base.slice(dotIndex + 1).toLowerCase();
}

export function resolveFilePreviewKind(path: string): FilePreviewKind {
  const ext = getFileExtension(path);
  if (HTML_EXTENSIONS.has(ext)) {
    return "html";
  }
  if (IMAGE_EXTENSIONS.has(ext)) {
    return "image";
  }
  if (MARKDOWN_EXTENSIONS.has(ext)) {
    return "markdown";
  }
  if (PDF_EXTENSIONS.has(ext)) {
    return "pdf";
  }
  return "text";
}

/** Whether a path should auto-render as live HTML (vs. showing source text). */
export function isAutoPreviewHtml(path: string): boolean {
  return resolveFilePreviewKind(path) === "html";
}
