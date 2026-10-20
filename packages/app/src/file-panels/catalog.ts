import type { FilePanelCandidate } from "./resolve";

const renderingPanels = [
  {
    id: "builtin:markdown",
    builtin: true,
    files: { extensions: ["md", "markdown"] },
    fileKind: "text",
  },
  {
    id: "builtin:html",
    builtin: true,
    files: { extensions: ["html", "htm"] },
    fileKind: "text",
  },
  {
    id: "builtin:image",
    builtin: true,
    files: { extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg"] },
    fileKind: "image",
  },
] as const satisfies readonly FilePanelCandidate[];

/** Paseo's editor. Every text file has it, so a text file always opens with some panel. */
export const sourceFilePanel = {
  id: "builtin:source",
  builtin: true,
  files: "all",
  fileKind: "text",
} as const satisfies FilePanelCandidate;

export type RenderingFilePanel = (typeof renderingPanels)[number];
export type SourceFilePanel = typeof sourceFilePanel;

/**
 * Every panel a host offers, in resolver order: the built-ins that render a file, then plugin
 * panels, then Source. Source is last so it is the default only when nothing else claims the file.
 */
export function filePanelCatalog<Plugin extends FilePanelCandidate>(
  pluginPanels: readonly Plugin[],
): readonly (RenderingFilePanel | Plugin | SourceFilePanel)[] {
  return [...renderingPanels, ...pluginPanels, sourceFilePanel];
}

/** Source is Paseo's own editor, so the file tab renders it rather than the panel host. */
export function isSourceFilePanel<Panel extends { id: string }>(
  panel: Panel | SourceFilePanel,
): panel is SourceFilePanel {
  return panel.id === sourceFilePanel.id;
}
