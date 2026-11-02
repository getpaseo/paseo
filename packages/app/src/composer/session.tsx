import { createContext, useContext, type ReactNode } from "react";
import type { JsonValue, ProviderOptions } from "@getpaseo/protocol/agent-types";
import type { UserComposerAttachment } from "@/attachments/types";
import type { ComposerTextSource } from "@/composer/text-source";

/**
 * The text and attachments of the composer a control sits in. `Composer` provides it, so a
 * control reaches the prompt without knowing which screen mounted the composer.
 */
export interface ComposerInput {
  /** The prompt is held while the composer submits; the built-in input is read-only meanwhile. */
  locked: boolean;
  textSource: ComposerTextSource;
  setText: (text: string) => void;
  /** Inserts at the cursor, replacing the selection. */
  insertText: (text: string) => void;
  attachments: readonly UserComposerAttachment[];
  changeAttachments: (
    updater: (current: UserComposerAttachment[]) => UserComposerAttachment[],
  ) => void;
}

/**
 * The agent a composer configures, as one set of reads and commands. A running agent sends each
 * command to the daemon; a draft keeps it locally until the agent is created. Controls call the
 * same command either way.
 */
export interface ComposerAgent {
  context: "agent" | "draft" | "new-workspace";
  /** The agent is being created; the built-in controls are disabled meanwhile. */
  locked: boolean;
  provider: string | null;
  model: string | null;
  mode: string | null;
  thinking: string | null;
  /** The options the agent runs with, defaults included. */
  options: ProviderOptions;
  metadata: Record<string, JsonValue>;
  setProvider: (provider: string) => Promise<void>;
  setModel: (modelId: string) => Promise<void>;
  setMode: (modeId: string) => Promise<void>;
  setThinking: (thinkingOptionId: string) => Promise<void>;
  /** Top-level keys replace; `null` removes the agent's own value. */
  setOptions: (patch: ProviderOptions) => Promise<void>;
  /** Top-level keys replace; `null` removes the key. */
  setMetadata: (patch: Record<string, JsonValue>) => Promise<void>;
}

const ComposerInputContext = createContext<ComposerInput | null>(null);
const ComposerAgentContext = createContext<ComposerAgent | null>(null);

export function ComposerInputProvider({
  value,
  children,
}: {
  value: ComposerInput;
  children: ReactNode;
}) {
  return <ComposerInputContext.Provider value={value}>{children}</ComposerInputContext.Provider>;
}

export function ComposerAgentProvider({
  value,
  children,
}: {
  value: ComposerAgent | null;
  children: ReactNode;
}) {
  return <ComposerAgentContext.Provider value={value}>{children}</ComposerAgentContext.Provider>;
}

export function useComposerInput(): ComposerInput | null {
  return useContext(ComposerInputContext);
}

export function useComposerAgent(): ComposerAgent | null {
  return useContext(ComposerAgentContext);
}

/** True while the composer holds its prompt or its agent's settings for a submit in flight. */
export function useComposerLocked(): boolean {
  const input = useComposerInput();
  const agent = useComposerAgent();
  return Boolean(input?.locked || agent?.locked);
}
