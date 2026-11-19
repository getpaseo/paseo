import {
  createContext,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ComponentType,
  type ReactNode,
} from "react";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type { PluginAttachmentItem } from "../attachments.js";
import type { PluginHostProps } from "./contracts.js";

/** One item the user attached from a source this plugin registered with `addAttachmentSource`. */
export interface PluginComposerAttachment {
  readonly sourceId: string;
  readonly item: PluginAttachmentItem;
}

/** Where the cursor goes when a composer takes focus. */
export interface PluginComposerFocusOptions {
  /** Offsets into `prompt`, clamped to its length. Equal offsets place the cursor. Omit to keep the cursor where it is. */
  selection?: { start: number; end: number };
}

/**
 * The composer the item sits in: the prompt, the attachments and the agent being configured.
 * The commands behave the same in every composer. `context` says where the composer is; it does
 * not change what a command does, except that a running agent keeps its provider.
 */
export interface PluginComposer {
  /** `"agent"`: a running agent. `"draft"`: a new agent in a workspace. `"new-workspace"`: the New workspace screen. */
  readonly context: "agent" | "draft" | "new-workspace";
  readonly prompt: string;
  /** This plugin's attachments only. */
  readonly attachments: readonly PluginComposerAttachment[];
  readonly agent: {
    readonly provider: string | null;
    readonly model: string | null;
    readonly mode: string | null;
    readonly thinking: string | null;
    /** The options the agent runs with, including provider defaults. */
    readonly options: Readonly<Record<string, JsonValue>>;
    readonly metadata: Readonly<Record<string, JsonValue>>;
  };
  setPrompt(text: string): void;
  /** Inserts at the cursor, replacing the selection. */
  insertText(text: string): void;
  /**
   * Puts the cursor in this composer, ready to type. Paseo opens the agent's tab or workspace when
   * it is not on screen. Resolves once the input has focus; rejects when it could not get there.
   */
  focus(options?: PluginComposerFocusOptions): Promise<void>;
  addAttachment(input: { sourceId: string; item: PluginAttachmentItem }): void;
  removeAttachment(input: { sourceId: string; itemId: string }): void;
  /** Resets the model like the built-in control. Rejects on a running agent, which keeps its provider. */
  setProvider(provider: string): Promise<void>;
  /** On a running agent, rejects with the provider's message when it refuses the model. */
  setModel(modelId: string): Promise<void>;
  setMode(modeId: string): Promise<void>;
  setThinking(thinkingOptionId: string): Promise<void>;
  /** Top-level keys replace; `null` removes the agent's own value. */
  setOptions(patch: Record<string, JsonValue>): Promise<void>;
  /** Top-level keys replace; `null` removes the key. */
  setMetadata(patch: Record<string, JsonValue>): Promise<void>;
}

export interface PluginComposerItemProps extends PluginHostProps {}

export interface PluginComposerItemContribution {
  id: string;
  Component: ComponentType<PluginComposerItemProps>;
}

const PluginComposerContext = createContext<PluginComposer | null>(null);

export function PluginComposerProvider({
  composer,
  children,
}: {
  composer: PluginComposer;
  children: ReactNode;
}) {
  return (
    <PluginComposerContext.Provider value={composer}>{children}</PluginComposerContext.Provider>
  );
}

export function usePluginComposerValue(): PluginComposer | null {
  return useContext(PluginComposerContext);
}

/** The composer this item sits in. Call it from a component registered with `addComposerItem`. */
export function useComposer(): PluginComposer {
  const composer = usePluginComposerValue();
  if (!composer) throw new Error("useComposer must run inside a composer item");
  return composer;
}

/**
 * Names the running agent whose composer a plugin wants. Both forms resolve to the same
 * `PluginComposer` an item of that agent's composer gets from `useComposer()`.
 */
export type PluginComposerSelector = { agentId: string } | { focused: true };

/** What `useComposers` and `composers(selector)` read. Paseo implements it per installed plugin. */
export interface PluginComposersSource {
  /** Tells `listener` when the composers `selector` names change, and keeps them live meanwhile. */
  subscribe(selector: PluginComposerSelector, listener: () => void): () => void;
  /** The composers `selector` names now: one for a known running agent, none otherwise. */
  resolve(selector: PluginComposerSelector): readonly PluginComposer[];
}

const PluginComposersContext = createContext<PluginComposersSource | null>(null);

export function PluginComposersProvider({
  source,
  children,
}: {
  source: PluginComposersSource;
  children: ReactNode;
}) {
  return (
    <PluginComposersContext.Provider value={source}>{children}</PluginComposersContext.Provider>
  );
}

export function usePluginComposersSource(): PluginComposersSource | null {
  return useContext(PluginComposersContext);
}

/**
 * The composers `selector` names, whether or not their tabs are open. Runs in any plugin
 * component. Empty for an unknown agent, or for `{ focused: true }` when no agent is focused.
 */
export function useComposers(selector: PluginComposerSelector): readonly PluginComposer[] {
  const source = useContext(PluginComposersContext);
  if (!source) throw new Error("useComposers must run inside a plugin component");
  // The selector is usually an inline literal; its content is what the subscription depends on.
  const selection = "agentId" in selector ? selector.agentId : null;
  const subscribe = useMemo(
    () => (listener: () => void) =>
      source.subscribe(selection === null ? { focused: true } : { agentId: selection }, listener),
    [source, selection],
  );
  return useSyncExternalStore(
    subscribe,
    () => source.resolve(selector),
    () => source.resolve(selector),
  );
}
