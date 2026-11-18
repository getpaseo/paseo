import type {
  PluginText,
  PluginButtonBehavior,
  PluginButton,
  PluginButtonContext,
  PluginButtonRegistration,
  PluginHeaderButtonContribution,
  PluginComposerPillContribution,
  PluginComposerToolbarButtonContribution,
  PluginVerticalBarButtonContribution,
} from "@getpaseo/plugin/client";
import type { InstalledPlugin } from "../types";
import {
  requireButtonId,
  validateButton,
  type ButtonValidation,
  type ResolvedPluginButton,
} from "./validation";

export type ButtonPlacement = "header" | "composer" | "composer-toolbar" | "vertical-bar";
export type GlobalButtonPlacement = Extract<ButtonPlacement, "composer-toolbar" | "vertical-bar">;

/** Global buttons belong to every composer or workspace; each supplies its context when it renders. */
export type RegisteredButtonContext = PluginButtonContext | { context: "global" };

export interface RegisteredPluginButton {
  key: number;
  id: string;
  installation: InstalledPlugin;
  placement: ButtonPlacement;
  context: RegisteredButtonContext;
  button: ResolvedPluginButton;
  pending: boolean;
  open: boolean;
  /** Increments only when the plugin replaces behavior. Label and locale updates keep it. */
  behaviorRevision: number;
}

function resolveAction(
  behavior: PluginButtonBehavior<PluginText>,
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
    input: PluginHeaderButtonContribution<PluginText>,
  ): PluginButtonRegistration<PluginText> {
    return this.add(installation, input, "header", {
      context: "workspace",
      workspaceId: input.workspaceId.trim(),
    });
  }

  addComposerPill(
    installation: InstalledPlugin,
    input: PluginComposerPillContribution<PluginText>,
  ): PluginButtonRegistration<PluginText> {
    if (!input.agentId.trim()) throw new Error("Plugin composer pill needs an agent");
    return this.add(installation, input, "composer", {
      context: "agent",
      workspaceId: input.workspaceId.trim(),
      agentId: input.agentId.trim(),
    });
  }

  addComposerToolbarButton(
    installation: InstalledPlugin,
    input: PluginComposerToolbarButtonContribution<PluginText>,
  ): PluginButtonRegistration<PluginText> {
    return this.add(installation, input, "composer-toolbar", { context: "global" });
  }

  addVerticalBarButton(
    installation: InstalledPlugin,
    input: PluginVerticalBarButtonContribution<PluginText>,
  ): PluginButtonRegistration<PluginText> {
    return this.add(installation, input, "vertical-bar", { context: "global" });
  }

  private add(
    installation: InstalledPlugin,
    input: { id: string; button: PluginButton<PluginText> },
    placement: ButtonPlacement,
    context: RegisteredButtonContext,
  ): PluginButtonRegistration<PluginText> {
    const id = requireButtonId(input.id);
    if (context.context !== "global" && !context.workspaceId.trim())
      throw new Error("Plugin button needs a workspace");
    const duplicate = this.entries.some(
      (entry) =>
        entry.installation === installation &&
        entry.placement === placement &&
        entry.id === id &&
        sameButtonContext(entry.context, context),
    );
    if (duplicate) throw new Error(`Duplicate plugin button: ${id}`);
    const key = this.nextKey++;
    let sourceButton: PluginButton<PluginText> = input.button;
    const initialButton = validateButton(sourceButton, this.validation, installation.i18n.resolve);
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
        behaviorRevision: 0,
      },
    ]);
    // A locale refresh rebuilds behavior text and must not bump behaviorRevision.
    const unsubscribe = installation.i18n.subscribe(() => {
      this.replace(key, {
        button: validateButton(sourceButton, this.validation, installation.i18n.resolve),
      });
    });
    return {
      update: (patch) => {
        const entry = this.entries.find((candidate) => candidate.key === key);
        if (!entry) return;
        const nextSource = { ...sourceButton, ...patch };
        const button = validateButton(nextSource, this.validation, installation.i18n.resolve);
        sourceButton = nextSource;
        const behaviorChanged = patch.behavior !== undefined;
        const close = !button.visible || button.disabled || behaviorChanged;
        const behaviorRevision = behaviorChanged
          ? entry.behaviorRevision + 1
          : entry.behaviorRevision;
        this.replace(key, { button, open: close ? false : entry.open, behaviorRevision });
      },
      remove: () => {
        unsubscribe();
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
    patch: Partial<
      Pick<RegisteredPluginButton, "button" | "open" | "pending" | "behaviorRevision">
    >,
  ): void {
    if (!this.entries.some((entry) => entry.key === key)) return;
    this.publish(this.entries.map((entry) => (entry.key === key ? { ...entry, ...patch } : entry)));
  }

  private publish(entries: readonly RegisteredPluginButton[]): void {
    this.entries = entries;
    for (const listener of this.listeners) listener();
  }
}

function sameButtonContext(a: RegisteredButtonContext, b: RegisteredButtonContext): boolean {
  if (a.context === "global" || b.context === "global") return a.context === b.context;
  if (a.workspaceId !== b.workspaceId) return false;
  return a.context === "workspace" || (b.context === "agent" && a.agentId === b.agentId);
}

export function globalButtonMatches(
  entry: RegisteredPluginButton,
  placement: GlobalButtonPlacement,
  serverId: string,
): boolean {
  return (
    entry.placement === placement &&
    entry.installation.serverId === serverId &&
    entry.button.visible
  );
}

export function buttonMatches(
  entry: RegisteredPluginButton,
  serverId: string,
  workspaceId: string,
  agentId: string | null,
): boolean {
  if (entry.context.context === "global") return false;
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
