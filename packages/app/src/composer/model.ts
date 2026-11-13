import { createContext, useContext } from "react";
import type { JsonValue, ProviderOptions } from "@getpaseo/protocol/agent-types";
import type { UserComposerAttachment } from "@/attachments/types";

/** Everything a plugin can read of a composer. A new object whenever any of it changes. */
export interface ComposerState {
  /** `"agent"`: a running agent. `"draft"`: a new agent in a workspace. `"new-workspace"`: the New workspace screen. */
  context: "agent" | "draft" | "new-workspace";
  prompt: string;
  attachments: readonly UserComposerAttachment[];
  provider: string | null;
  model: string | null;
  mode: string | null;
  thinking: string | null;
  /** The options the agent runs with, defaults included. */
  options: ProviderOptions;
  metadata: Record<string, JsonValue>;
}

/** Where the cursor goes when a composer takes focus. */
export interface ComposerFocusOptions {
  /** Offsets into the prompt, clamped to its length. Omit to keep the cursor where it is. */
  selection?: { start: number; end: number };
}

/**
 * A composer as plugins use it: its state, a way to hear about changes, and the commands that
 * change it. The commands enforce the rules the built-in controls follow (a draft being created
 * is locked, a running agent keeps its provider). A running agent's model lives in the stores and
 * exists whether or not its tab is open; a draft's is built from its mounted composer.
 */
export interface ComposerModel {
  getState(): ComposerState;
  subscribe(listener: () => void): () => void;
  setPrompt(text: string): void;
  /** Inserts at the cursor, replacing the selection. */
  insertText(text: string): void;
  /** Puts the cursor in the input. Resolves once it is there; rejects when it cannot get there. */
  focus(options?: ComposerFocusOptions): Promise<void>;
  changeAttachments(updater: (current: UserComposerAttachment[]) => UserComposerAttachment[]): void;
  setProvider(provider: string): Promise<void>;
  setModel(modelId: string): Promise<void>;
  setMode(modeId: string): Promise<void>;
  setThinking(thinkingOptionId: string): Promise<void>;
  /** Top-level keys replace; `null` removes the agent's own value. */
  setOptions(patch: ProviderOptions): Promise<void>;
  /** Top-level keys replace; `null` removes the key. */
  setMetadata(patch: Record<string, JsonValue>): Promise<void>;
}

const ComposerModelContext = createContext<ComposerModel | null>(null);

export const ComposerModelProvider = ComposerModelContext.Provider;

/** The model of the composer this control sits in. */
export function useComposerModel(): ComposerModel | null {
  return useContext(ComposerModelContext);
}
