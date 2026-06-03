import { vi } from "vitest";

import { getAgentProviderDefinition } from "@getpaseo/protocol/provider-manifest";

import type {
  AgentMode,
  AgentModelDefinition,
  AgentProvider,
  ProviderSnapshotEntry,
} from "../agent/agent-sdk-types.js";
import type {
  AgentManagerProviderState,
  ProviderDiagnosticResult,
  ResolvedProviderCreateConfig,
} from "../agent/provider-snapshot-manager.js";
import { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import type { SessionOptions } from "../session.js";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { asInternals, createStub } from "./class-mocks.js";

// ---------------------------------------------------------------------------
// Typed stub wrappers — unsafe cast is in createStub (class-mocks.ts), never
// directly in test files. Wrapper signatures narrow the accepted key set so
// callers get compile-time feedback on typos in method names.
// ---------------------------------------------------------------------------

export function asSessionLogger(stub: {
  [K in keyof SessionOptions["logger"]]?: unknown;
}): SessionOptions["logger"] {
  return createStub<SessionOptions["logger"]>(stub);
}

export function asAgentManager(stub: {
  [K in keyof SessionOptions["agentManager"]]?: unknown;
}): SessionOptions["agentManager"] {
  return createStub<SessionOptions["agentManager"]>(stub);
}

export function asAgentStorage(stub: {
  [K in keyof SessionOptions["agentStorage"]]?: unknown;
}): SessionOptions["agentStorage"] {
  return createStub<SessionOptions["agentStorage"]>(stub);
}

export function asDownloadTokenStore(): SessionOptions["downloadTokenStore"] {
  return createStub<SessionOptions["downloadTokenStore"]>({});
}

export function asPushTokenStore(): SessionOptions["pushTokenStore"] {
  return createStub<SessionOptions["pushTokenStore"]>({});
}

export function asChatService(): SessionOptions["chatService"] {
  return createStub<SessionOptions["chatService"]>({});
}

export function asScheduleService(): SessionOptions["scheduleService"] {
  return createStub<SessionOptions["scheduleService"]>({});
}

export function asLoopService(): SessionOptions["loopService"] {
  return createStub<SessionOptions["loopService"]>({});
}

export function asCheckoutDiffManager(stub: {
  [K in keyof SessionOptions["checkoutDiffManager"]]?: unknown;
}): SessionOptions["checkoutDiffManager"] {
  return createStub<SessionOptions["checkoutDiffManager"]>(stub);
}

export function asDaemonConfigStore(stub: {
  [K in keyof SessionOptions["daemonConfigStore"]]?: unknown;
}): SessionOptions["daemonConfigStore"] {
  return createStub<SessionOptions["daemonConfigStore"]>(stub);
}

export function asTerminalManager(stub: {
  [K in keyof NonNullable<SessionOptions["terminalManager"]>]?: unknown;
}): NonNullable<SessionOptions["terminalManager"]> {
  return createStub<NonNullable<SessionOptions["terminalManager"]>>(stub);
}

export function asGitHubService(stub: {
  [K in keyof NonNullable<SessionOptions["github"]>]?: unknown;
}): NonNullable<SessionOptions["github"]> {
  return createStub<NonNullable<SessionOptions["github"]>>(stub);
}

export function asWorkspaceGitService(stub: {
  [K in keyof SessionOptions["workspaceGitService"]]?: unknown;
}): SessionOptions["workspaceGitService"] {
  return createStub<SessionOptions["workspaceGitService"]>(stub);
}

export function asServiceProxy(stub: {
  [K in keyof SessionOptions["serviceProxy"]]?: unknown;
}): SessionOptions["serviceProxy"] {
  return createStub<SessionOptions["serviceProxy"]>(stub);
}

export function asWorkspaceScriptRuntimeStore(stub: {
  [K in keyof SessionOptions["scriptRuntimeStore"]]?: unknown;
}): SessionOptions["scriptRuntimeStore"] {
  return createStub<SessionOptions["scriptRuntimeStore"]>(stub);
}

// ---------------------------------------------------------------------------
// Private session access — delegates to asInternals so test files need no cast
// ---------------------------------------------------------------------------

export { asInternals as asSessionInternals };

// ---------------------------------------------------------------------------
// Type guard for SessionOutboundMessage — avoids casting unknown in test emit overrides
// ---------------------------------------------------------------------------

export function isSessionOutboundMessage(m: unknown): m is SessionOutboundMessage {
  return typeof m === "object" && m !== null && "type" in m;
}

// ---------------------------------------------------------------------------
// Message helpers — type-safe filtering without casts in test files
// ---------------------------------------------------------------------------

export function filterByType<T extends SessionOutboundMessage["type"]>(
  messages: SessionOutboundMessage[],
  type: T,
): Array<Extract<SessionOutboundMessage, { type: T }>> {
  return messages.filter((m): m is Extract<SessionOutboundMessage, { type: T }> => m.type === type);
}

export function findByType<T extends SessionOutboundMessage["type"]>(
  messages: SessionOutboundMessage[],
  type: T,
): Extract<SessionOutboundMessage, { type: T }> | undefined {
  return messages.find((m): m is Extract<SessionOutboundMessage, { type: T }> => m.type === type);
}

// ---------------------------------------------------------------------------
// ProviderSnapshotManager stub — returns spies separately to avoid
// unbound-method lint errors when using expect(spy).toHaveBeenCalled()
// ---------------------------------------------------------------------------

export interface ProviderSnapshotManagerSpies {
  getSnapshot: ReturnType<typeof vi.fn<[cwd?: string], ProviderSnapshotEntry[]>>;
  refreshSnapshotForCwd: ReturnType<typeof vi.fn<[unknown], Promise<void>>>;
  refreshSettingsSnapshot: ReturnType<typeof vi.fn<[unknown], Promise<void>>>;
  warmUpSnapshotForCwd: ReturnType<typeof vi.fn<[unknown], Promise<void>>>;
  listRegisteredProviderIds: ReturnType<typeof vi.fn<[], AgentProvider[]>>;
  hasProvider: ReturnType<typeof vi.fn<[AgentProvider], boolean>>;
  getProviderLabel: ReturnType<typeof vi.fn<[AgentProvider], string>>;
  getAgentManagerProviderState: ReturnType<typeof vi.fn<[], AgentManagerProviderState>>;
  listProviders: ReturnType<typeof vi.fn<[unknown], Promise<ProviderSnapshotEntry[]>>>;
  getProvider: ReturnType<typeof vi.fn<[unknown], Promise<ProviderSnapshotEntry>>>;
  listModels: ReturnType<typeof vi.fn<[unknown], Promise<AgentModelDefinition[]>>>;
  listModes: ReturnType<typeof vi.fn<[unknown], Promise<AgentMode[]>>>;
  resolveCreateConfig: ReturnType<typeof vi.fn<[unknown], Promise<ResolvedProviderCreateConfig>>>;
  resolveDefaultModel: ReturnType<typeof vi.fn<[unknown], Promise<string | undefined>>>;
  getProviderDiagnostic: ReturnType<
    typeof vi.fn<[AgentProvider], Promise<ProviderDiagnosticResult>>
  >;
  applyMutableProviderConfig: ReturnType<typeof vi.fn<[unknown], AgentManagerProviderState>>;
  destroy: ReturnType<typeof vi.fn<[], void>>;
}

export function createProviderSnapshotManagerStub(): {
  manager: ProviderSnapshotManager;
} & ProviderSnapshotManagerSpies {
  const getSnapshot = vi.fn<[cwd?: string], ProviderSnapshotEntry[]>(() => []);
  const refreshSnapshotForCwd = vi.fn<[unknown], Promise<void>>(async () => {});
  const refreshSettingsSnapshot = vi.fn<[unknown], Promise<void>>(async () => {});
  const warmUpSnapshotForCwd = vi.fn<[unknown], Promise<void>>(async () => {});
  const listRegisteredProviderIds = vi.fn<[], AgentProvider[]>(() => []);
  const hasProvider = vi.fn<[AgentProvider], boolean>(() => false);
  const getProviderLabel = vi.fn<[AgentProvider], string>((provider) => {
    try {
      return getAgentProviderDefinition(provider).label;
    } catch {
      return provider;
    }
  });
  const getAgentManagerProviderState = vi.fn<[], AgentManagerProviderState>(() => ({
    providerDefinitions: {},
    clients: {},
  }));
  const listProviders = vi.fn<[unknown], Promise<ProviderSnapshotEntry[]>>(async () => []);
  const getProvider = vi.fn<[unknown], Promise<ProviderSnapshotEntry>>(async () => {
    throw new Error("createProviderSnapshotManagerStub: getProvider not stubbed");
  });
  const listModels = vi.fn<[unknown], Promise<AgentModelDefinition[]>>(async () => []);
  const listModes = vi.fn<[unknown], Promise<AgentMode[]>>(async () => []);
  const resolveCreateConfig = vi.fn<[unknown], Promise<ResolvedProviderCreateConfig>>(async () => ({
    modeId: undefined,
    featureValues: undefined,
  }));
  const resolveDefaultModel = vi.fn<[unknown], Promise<string | undefined>>(async () => undefined);
  const getProviderDiagnostic = vi.fn<[AgentProvider], Promise<ProviderDiagnosticResult>>(
    async (provider) => ({ provider, diagnostic: "No diagnostic available for this provider." }),
  );
  const applyMutableProviderConfig = vi.fn<[unknown], AgentManagerProviderState>(() => ({
    providerDefinitions: {},
    clients: {},
  }));
  const on = vi.fn();
  const off = vi.fn();
  const destroy = vi.fn<[], void>();
  const stub = {
    getSnapshot,
    refreshSnapshotForCwd,
    refreshSettingsSnapshot,
    warmUpSnapshotForCwd,
    listRegisteredProviderIds,
    hasProvider,
    getProviderLabel,
    getAgentManagerProviderState,
    listProviders,
    getProvider,
    listModels,
    listModes,
    resolveCreateConfig,
    resolveDefaultModel,
    getProviderDiagnostic,
    applyMutableProviderConfig,
    on,
    off,
    destroy,
  };
  on.mockImplementation(() => stub);
  off.mockImplementation(() => stub);
  const manager = createStub<ProviderSnapshotManager>(stub);
  return {
    manager,
    getSnapshot,
    refreshSnapshotForCwd,
    refreshSettingsSnapshot,
    warmUpSnapshotForCwd,
    listRegisteredProviderIds,
    hasProvider,
    getProviderLabel,
    getAgentManagerProviderState,
    listProviders,
    getProvider,
    listModels,
    listModes,
    resolveCreateConfig,
    resolveDefaultModel,
    getProviderDiagnostic,
    applyMutableProviderConfig,
    destroy,
  };
}
