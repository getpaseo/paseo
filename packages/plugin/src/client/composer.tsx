import { createContext, useContext, type ComponentType, type ReactNode } from "react";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type { PluginAttachmentItem } from "../attachments.js";
import type { PluginHostProps } from "./contracts.js";

/** One item the user attached from a source this plugin registered with `addAttachmentSource`. */
export interface PluginComposerAttachment {
  readonly sourceId: string;
  readonly item: PluginAttachmentItem;
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
  addAttachment(input: { sourceId: string; item: PluginAttachmentItem }): void;
  removeAttachment(input: { sourceId: string; itemId: string }): void;
  /** Resets the model like the built-in control. Rejects on a running agent, which keeps its provider. */
  setProvider(provider: string): Promise<void>;
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
