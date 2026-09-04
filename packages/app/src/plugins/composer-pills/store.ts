import type { PluginComposerPillContribution } from "@getpaseo/plugin";
import type { InstalledPlugin } from "../types";

const CONTRIBUTION_ID = /^[a-z][a-z0-9-]*$/;

export interface RegisteredPluginComposerPill {
  installation: InstalledPlugin;
  contribution: PluginComposerPillContribution;
}

class PluginComposerPillStore {
  private entries: RegisteredPluginComposerPill[] = [];
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): readonly RegisteredPluginComposerPill[] => this.entries;

  add(installation: InstalledPlugin, input: PluginComposerPillContribution): () => void {
    const contribution = validateContribution(input);
    const duplicate = this.entries.some(
      (entry) =>
        entry.installation === installation &&
        entry.contribution.workspaceId === contribution.workspaceId &&
        entry.contribution.agentId === contribution.agentId &&
        entry.contribution.id === contribution.id,
    );
    if (duplicate) {
      throw new Error(`Duplicate composer pill: ${contribution.id}`);
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
  contribution: PluginComposerPillContribution,
): PluginComposerPillContribution {
  const id = contribution.id.trim();
  const title = contribution.title.trim();
  const workspaceId = contribution.workspaceId.trim();
  const agentId = contribution.agentId.trim();
  if (!CONTRIBUTION_ID.test(id)) throw new Error(`Invalid composer pill id: ${contribution.id}`);
  if (!title) throw new Error(`Composer pill ${id} has no title`);
  if (!workspaceId) throw new Error(`Composer pill ${id} has no workspace`);
  if (!agentId) throw new Error(`Composer pill ${id} has no agent`);
  if (typeof contribution.Component !== "function") {
    throw new Error(`Composer pill ${id} is not a component`);
  }
  if (typeof contribution.onPress !== "function") {
    throw new Error(`Composer pill ${id} has no callback`);
  }
  return { ...contribution, id, title, workspaceId, agentId };
}

export const pluginComposerPillStore = new PluginComposerPillStore();
