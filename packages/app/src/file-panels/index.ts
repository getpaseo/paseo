import type { ExplorerFile } from "@/stores/session-store";
import { builtinFilePanels } from "./catalog";
import { resolveFilePanel } from "./resolve";

export { resolveFilePanel, type FilePanelCandidate, type FilePanelFile } from "./resolve";
export { builtinFilePanels, isRenderedMarkdownFile } from "./catalog";
export { FilePanelPreview } from "./builtin";

export type FilePanel = (typeof builtinFilePanels)[number];

export function resolveFilePreviewPanel(input: {
  preview: ExplorerFile | null;
  path: string;
  associations: Readonly<Record<string, string>>;
}) {
  const { preview, path, associations } = input;
  if (!preview) return null;
  return resolveFilePanel({
    file: { path, kind: preview.kind, size: preview.size, hasBytes: preview.kind === "image" },
    candidates: builtinFilePanels,
    associations,
  }).panel;
}
