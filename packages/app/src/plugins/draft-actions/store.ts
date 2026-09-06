import type { PluginDraftActionContribution } from "@getpaseo/plugin";
import type { InstalledPlugin } from "../types";

const CONTRIBUTION_ID = /^[a-z][a-z0-9-]*$/;

export interface RegisteredPluginDraftAction {
  installation: InstalledPlugin;
  contribution: PluginDraftActionContribution;
}

class PluginDraftActionStore {
  private entries: RegisteredPluginDraftAction[] = [];
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): readonly RegisteredPluginDraftAction[] => this.entries;

  add(installation: InstalledPlugin, input: PluginDraftActionContribution): () => void {
    const contribution = validateContribution(input);
    const duplicate = this.entries.some(
      (entry) => entry.installation === installation && entry.contribution.id === contribution.id,
    );
    if (duplicate) {
      throw new Error(`Duplicate draft action: ${contribution.id}`);
    }
    const entry = { installation, contribution };
    this.entries = [...this.entries, entry];
    this.publish();
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      this.entries = this.entries.filter((candidate) => candidate !== entry);
      this.publish();
    };
  }

  removeInstallation(installation: InstalledPlugin): void {
    const next = this.entries.filter((entry) => entry.installation !== installation);
    if (next.length === this.entries.length) return;
    this.entries = next;
    this.publish();
  }

  private publish(): void {
    for (const listener of this.listeners) listener();
  }
}

function validateContribution(
  contribution: PluginDraftActionContribution,
): PluginDraftActionContribution {
  const id = contribution.id.trim();
  const title = contribution.title.trim();
  if (!CONTRIBUTION_ID.test(id)) throw new Error(`Invalid draft action id: ${contribution.id}`);
  if (!title) throw new Error(`Draft action ${id} has no title`);
  if (typeof contribution.transform !== "function") {
    throw new Error(`Draft action ${id} has no transform`);
  }
  return { ...contribution, id, title };
}

export const pluginDraftActionStore = new PluginDraftActionStore();
