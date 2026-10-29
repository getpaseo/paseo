import type { TFunction } from "i18next";
import type { PluginIcon } from "@getpaseo/plugin/client";
import type { FilePanel } from "../panels";
import { parseFilePanelSelectorKey } from "../resolve";

const BUILTIN_PRESENTATION = {
  "builtin:markdown": { title: "markdown", icon: "FileText" },
  "builtin:html": { title: "html", icon: "FileCode" },
  "builtin:image": { title: "image", icon: "Image" },
  "builtin:source": { title: "source", icon: "Code" },
} as const;

export function filePanelIcon(panel: FilePanel): PluginIcon {
  return panel.builtin ? BUILTIN_PRESENTATION[panel.id].icon : panel.contribution.icon;
}

/** "Markdown", "Rich Markdown": the panel's title. */
export function filePanelTitle(t: TFunction, panel: FilePanel): string {
  return panel.builtin
    ? t(`panels.file.filePanels.builtin.${BUILTIN_PRESENTATION[panel.id].title}`)
    : panel.plugin.i18n.resolve(panel.contribution.title, panel.plugin.locale);
}

/** "Markdown — Paseo", "Rich Markdown — markdown-panel". */
export function filePanelOptionLabel(t: TFunction, panel: FilePanel): string {
  return t("panels.file.filePanels.option", {
    title: filePanelTitle(t, panel),
    owner: panel.builtin ? t("panels.file.filePanels.builtin.owner") : panel.plugin.id,
  });
}

/** ".md" for an extension key, "Dockerfile" for a filename key. */
export function filePanelSelectorLabel(selectorKey: string): string {
  const selector = parseFilePanelSelectorKey(selectorKey);
  return selector.kind === "name" ? selector.value : `.${selector.value}`;
}

/** "Open .md files with" for an extension key, "Open Dockerfile with" for a filename key. */
export function filePanelPickerTitle(t: TFunction, selectorKey: string): string {
  const selector = parseFilePanelSelectorKey(selectorKey);
  return selector.kind === "name"
    ? t("panels.file.filePanels.pickerTitleFilename", { filename: selector.value })
    : t("panels.file.filePanels.pickerTitleExtension", { extension: selector.value });
}

/** "Always use for .md", "Always use for Dockerfile". */
export function filePanelAlwaysUseLabel(t: TFunction, selectorKey: string): string {
  const selector = parseFilePanelSelectorKey(selectorKey);
  return selector.kind === "name"
    ? t("panels.file.filePanels.alwaysUseFilename", { filename: selector.value })
    : t("panels.file.filePanels.alwaysUseExtension", { extension: selector.value });
}
