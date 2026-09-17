import type {
  PluginButtonBehavior,
  PluginButtonContext,
  PluginButtonRegistration,
  PluginHeaderButtonContribution,
  PluginComposerPillContribution,
} from "@getpaseo/plugin/client";
import type { InstalledPlugin } from "../types";
import {
  requireButtonId,
  validateButton,
  type ButtonValidation,
  type ResolvedPluginButton,
} from "./validation";

export type ButtonPlacement = "header" | "composer";

export interface RegisteredPluginButton {
  key: number;
  id: string;
  installation: InstalledPlugin;
  placement: ButtonPlacement;
  context: PluginButtonContext;
  button: ResolvedPluginButton;
  pending: boolean;
  open: boolean;
}

function resolveAction(
  behavior: PluginButtonBehavior,
  path: readonly string[],
): (() => void | Promise<void>) | null {
  if (path.length === 0) return behavior.kind === "action" ? behavior.onPress : null;
  if (behavior.kind !== "menu") return null;
  const item = behavior.items.find((entry) => entry.id === path[0]);
  if (!item || item.kind !== "item" || item.visible === false || item.disabled) return null;
  return resolveAction(item.behavior, path.slice(1));
}

export class PluginButtonStore {
  private entries: readonly RegisteredPluginButton[] = [];
  private nextKey = 0;
  private listeners = new Set<() => void>();

  constructor(private validation: ButtonValidation) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): readonly RegisteredPluginButton[] => this.entries;

  addHeaderButton(
    installation: InstalledPlugin,
    input: PluginHeaderButtonContribution,
  ): PluginButtonRegistration {
    return this.add(installation, input, "header", {
      context: "workspace",
      workspaceId: input.workspaceId.trim(),
    });
  }

  addComposerPill(
    installation: InstalledPlugin,
    input: PluginComposerPillContribution,
  ): PluginButtonRegistration {
    if (!input.agentId.trim()) throw new Error("Plugin composer pill needs an agent");
    return this.add(installation, input, "composer", {
      context: "agent",
      workspaceId: input.workspaceId.trim(),
      agentId: input.agentId.trim(),
    });
  }

  private add(
    installation: InstalledPlugin,
    input: PluginHeaderButtonContribution,
    placement: ButtonPlacement,
    context: PluginButtonContext,
  ): PluginButtonRegistration {
    const id = requireButtonId(input.id);
    if (!context.workspaceId.trim()) throw new Error("Plugin button needs a workspace");
    const duplicate = this.entries.some(
      (entry) =>
        entry.installation === installation &&
        entry.placement === placement &&
        entry.id === id &&
        entry.context.workspaceId === context.workspaceId &&
        (entry.context.context === "workspace" ||
          (context.context === "agent" && entry.context.agentId === context.agentId)),
    );
    if (duplicate) throw new Error(`Duplicate plugin button: ${id}`);
    const key = this.nextKey++;
    const initialButton = validateButton(input.button, this.validation);
    this.publish([
      ...this.entries,
      {
        key,
        id,
        installation,
        placement,
        context,
        button: initialButton,
        pending: false,
        open: false,
      },
    ]);
    return {
      update: (patch) => {
        const entry = this.entries.find((candidate) => candidate.key === key);
        if (!entry) return;
        const button = validateButton({ ...entry.button, ...patch }, this.validation);
        const close = !button.visible || button.disabled || patch.behavior !== undefined;
        this.replace(key, { button, open: close ? false : entry.open });
      },
      remove: () => {
        const next = this.entries.filter((entry) => entry.key !== key);
        if (next.length !== this.entries.length) this.publish(next);
      },
    };
  }

  setOpen(key: number, open: boolean): void {
    const entry = this.entries.find((candidate) => candidate.key === key);
    if (!entry) return;
    if (open && (!entry.button.visible || entry.button.disabled || entry.pending)) return;
    this.replace(key, { open });
  }

  async run(key: number, path: readonly string[] = []): Promise<void> {
    const entry = this.entries.find((candidate) => candidate.key === key);
    if (!entry || !entry.button.visible || entry.button.disabled || entry.pending) return;
    const action = resolveAction(entry.button.behavior, path);
    if (!action) return;
    this.replace(key, { pending: true });
    try {
      await action();
    } finally {
      this.replace(key, { pending: false });
    }
  }

  private replace(
    key: number,
    patch: Partial<Pick<RegisteredPluginButton, "button" | "open" | "pending">>,
  ): void {
    if (!this.entries.some((entry) => entry.key === key)) return;
    this.publish(this.entries.map((entry) => (entry.key === key ? { ...entry, ...patch } : entry)));
  }

  private publish(entries: readonly RegisteredPluginButton[]): void {
    this.entries = entries;
    for (const listener of this.listeners) listener();
  }
}

export function buttonMatches(
  entry: RegisteredPluginButton,
  serverId: string,
  workspaceId: string,
  agentId: string | null,
): boolean {
  if (
    entry.installation.serverId !== serverId ||
    entry.context.workspaceId !== workspaceId ||
    !entry.button.visible
  )
    return false;
  if (agentId === null) return entry.placement === "header";
  return (
    entry.placement === "composer" &&
    entry.context.context === "agent" &&
    entry.context.agentId === agentId
  );
}
