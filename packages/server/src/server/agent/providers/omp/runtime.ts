import type {
  OmpAgentMessage,
  OmpModel,
  OmpPromptAck,
  OmpRpcHostToolDefinition,
  OmpRpcHostToolResult,
  OmpRpcHostToolUpdate,
  OmpRpcSlashCommand,
  OmpRuntimeEvent,
  OmpSessionState,
  OmpSessionStats,
  OmpSubagentSnapshot,
  OmpSubagentSubscriptionLevel,
  OmpThinkingLevel,
} from "./rpc-types.js";
import type { ProviderRuntimeSettings } from "../../provider-launch-config.js";

export interface OmpRuntimeLaunch {
  cwd: string;
  argv: string[];
  env?: Record<string, string>;
  protocolMode?: "rpc" | "rpc-ui";
  model?: string;
  thinkingOptionId?: string;
  modeId?: string;
  session?: string;
  noSession?: boolean;
  systemPrompt?: string;
  extraArgs?: string[];
}

export interface OmpStartSessionInput {
  cwd: string;
  env?: Record<string, string>;
  protocolMode?: "rpc" | "rpc-ui";
  model?: string;
  thinkingOptionId?: string;
  modeId?: string;
  session?: string;
  noSession?: boolean;
  systemPrompt?: string;
  extraArgs?: string[];
}

export interface OmpRuntimeSession {
  onEvent(callback: (event: OmpRuntimeEvent) => void): () => void;
  prompt(
    message: string,
    images?: Array<{ type: "image"; data: string; mimeType: string }>,
  ): Promise<OmpPromptAck>;
  compact(customInstructions?: string): Promise<void>;
  setAutoCompaction(enabled: boolean): Promise<void>;
  abort(): Promise<void>;
  getState(): Promise<OmpSessionState>;
  getMessages(): Promise<OmpAgentMessage[]>;
  getAvailableModels(timeoutMs?: number): Promise<OmpModel[]>;
  setModel(provider: string, modelId: string): Promise<OmpModel>;
  setThinkingLevel(level: OmpThinkingLevel): Promise<void>;
  getSessionStats(): Promise<OmpSessionStats>;
  getCommands(): Promise<OmpRpcSlashCommand[]>;
  setSubagentSubscription(level: OmpSubagentSubscriptionLevel): Promise<void>;
  /** OMP source-of-truth list of internal task children (may throw on old binaries). */
  getSubagents(): Promise<OmpSubagentSnapshot[]>;
  setHostTools(tools: OmpRpcHostToolDefinition[]): Promise<string[]>;
  sendHostToolResult(result: OmpRpcHostToolResult): void;
  sendHostToolUpdate(update: OmpRpcHostToolUpdate): void;
  branch(entryId: string): Promise<{ text: string }>;
  getBranchMessages(): Promise<Array<{ entryId: string; text: string }>>;
  activeBranchEntryId?: string;
  steer(message: string, images?: Array<{ type: "image"; data: string; mimeType: string }>): void;
  followUp(
    message: string,
    images?: Array<{ type: "image"; data: string; mimeType: string }>,
  ): void;
  handoff(customInstructions?: string): Promise<void>;
  respondToExtensionUiRequest(
    id: string,
    response: { value?: string; confirmed?: boolean; cancelled?: boolean },
  ): void;
  cancelExtensionUiRequest(id: string): void;
  close(): Promise<void>;
}

export interface OmpRuntime {
  startSession(input: OmpStartSessionInput): Promise<OmpRuntimeSession>;
}

export function buildOmpLaunch(input: {
  command: [string, ...string[]];
  runtimeSettings?: ProviderRuntimeSettings;
  session: OmpStartSessionInput;
}): OmpRuntimeLaunch {
  const command =
    input.runtimeSettings?.command?.mode === "replace" && input.runtimeSettings.command.argv[0]
      ? input.runtimeSettings.command.argv
      : input.command;
  const argv = [...command];

  const protocolMode = input.session.protocolMode ?? "rpc";
  const systemPrompt = input.session.systemPrompt?.trim();
  appendOmpLaunchArgs(argv, input.session, protocolMode, systemPrompt);

  return {
    cwd: input.session.cwd,
    argv,
    env:
      input.runtimeSettings?.env || input.session.env
        ? {
            ...input.runtimeSettings?.env,
            ...input.session.env,
          }
        : undefined,
    model: input.session.model,
    thinkingOptionId: input.session.thinkingOptionId,
    protocolMode,
    modeId: input.session.modeId,
    session: input.session.session,
    noSession: input.session.noSession,
    systemPrompt,
    extraArgs: input.session.extraArgs,
  };
}

function appendOmpLaunchArgs(
  argv: string[],
  session: OmpStartSessionInput,
  protocolMode: "rpc" | "rpc-ui",
  systemPrompt: string | undefined,
): void {
  if (!hasModeFlag(argv)) {
    argv.push("--mode", protocolMode);
  }
  if (session.extraArgs?.length) {
    argv.push(...session.extraArgs);
  }
  if (session.model) {
    argv.push("--model", session.model);
  }
  if (session.thinkingOptionId) {
    argv.push("--thinking", session.thinkingOptionId);
  }
  if (session.noSession) {
    argv.push("--no-session");
  } else if (session.session) {
    argv.push("--session", session.session);
  }
  if (systemPrompt) {
    argv.push("--append-system-prompt", systemPrompt);
  }
}

function hasModeFlag(argv: string[]): boolean {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--mode") {
      return true;
    }
    if (argv[i]?.startsWith("--mode=")) {
      return true;
    }
  }
  return false;
}
