import type {
  PluginComposerPlaceholderContribution,
  PluginComposerPlaceholderRegistration,
} from "@getpaseo/plugin/client";
import type { InstalledPlugin } from "../types";

interface ComposerPlaceholderEntry {
  key: number;
  installation: InstalledPlugin;
  serverId: string;
  agentId: string;
  text: string;
}

const MAX_PLACEHOLDER_LENGTH = 500;

export function normalizeComposerPlaceholder(text: string): string | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return normalized.length > MAX_PLACEHOLDER_LENGTH
    ? normalized.slice(0, MAX_PLACEHOLDER_LENGTH).trimEnd()
    : normalized;
}

export class ComposerPlaceholderStore {
  private entries: readonly ComposerPlaceholderEntry[] = [];
  private nextKey = 0;
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): readonly ComposerPlaceholderEntry[] => this.entries;

  textFor(serverId: string, agentId: string): string | null {
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index];
      if (
        entry.serverId === serverId &&
        entry.agentId === agentId &&
        entry.text &&
        !entry.installation.lifetime.signal.aborted
      ) {
        return entry.text;
      }
    }
    return null;
  }

  set(
    installation: InstalledPlugin,
    input: PluginComposerPlaceholderContribution,
  ): PluginComposerPlaceholderRegistration {
    const agentId = input.agentId.trim();
    if (!agentId) throw new Error("Plugin composer placeholder needs an agent");
    const key = this.nextKey++;
    const entry: ComposerPlaceholderEntry = {
      key,
      installation,
      serverId: installation.serverId,
      agentId,
      text: normalizeComposerPlaceholder(input.text) ?? "",
    };
    const signal = installation.lifetime.signal;
    if (signal.aborted) {
      return { update() {}, remove() {} };
    }
    this.publish([...this.entries, entry]);
    let active = true;
    const remove = () => {
      if (!active) return;
      active = false;
      signal.removeEventListener("abort", remove);
      this.publish(this.entries.filter((candidate) => candidate.key !== key));
    };
    signal.addEventListener("abort", remove, { once: true });
    return {
      update: (text) => {
        if (!active) return;
        this.replace(key, normalizeComposerPlaceholder(text) ?? "");
      },
      remove,
    };
  }

  private replace(key: number, text: string): void {
    const index = this.entries.findIndex((entry) => entry.key === key);
    if (index === -1) return;
    const next = this.entries.slice();
    next[index] = { ...next[index], text };
    this.publish(next);
  }

  private publish(entries: readonly ComposerPlaceholderEntry[]): void {
    this.entries = entries;
    for (const listener of this.listeners) listener();
  }
}
