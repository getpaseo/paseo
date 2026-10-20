import { filePanelExtension, type FilePanelCandidate } from "./resolve";

const markdownPanel = {
  id: "builtin:markdown",
  files: { extensions: ["md", "markdown"] },
  document: "text",
  maxBytes: Infinity,
} as const satisfies FilePanelCandidate;

export const builtinFilePanels = [
  markdownPanel,
  {
    id: "builtin:html",
    files: { extensions: ["html", "htm"] },
    document: "text",
    maxBytes: Infinity,
  },
  {
    id: "builtin:image",
    files: { extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg"] },
    document: "bytes",
    maxBytes: Infinity,
  },
] as const satisfies readonly FilePanelCandidate[];

export function isRenderedMarkdownFile(path: string): boolean {
  return markdownPanel.files.extensions.some((extension) => extension === filePanelExtension(path));
}
