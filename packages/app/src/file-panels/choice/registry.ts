import {
  buildPanelInstanceKey,
  type PanelInstanceIdentity,
} from "@/panels/panel-instance-attributes";
import type { FilePanel } from "../panels";
import type { FilePanelChoiceModel } from "./model";

/**
 * The open file tabs' choice models, so tab chrome outside the pane (the tab's context menu)
 * reads and drives the same choice the pane renders.
 */
const models = new Map<string, FilePanelChoiceModel<FilePanel>>();
const listeners = new Set<() => void>();

export function registerFilePanelChoice(
  identity: PanelInstanceIdentity,
  model: FilePanelChoiceModel<FilePanel>,
): () => void {
  const key = buildPanelInstanceKey(identity);
  models.set(key, model);
  notify();
  return () => {
    if (models.get(key) !== model) return;
    models.delete(key);
    notify();
  };
}

export function getFilePanelChoice(
  identity: PanelInstanceIdentity,
): FilePanelChoiceModel<FilePanel> | null {
  return models.get(buildPanelInstanceKey(identity)) ?? null;
}

export function subscribeFilePanelChoices(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const listener of listeners) listener();
}
