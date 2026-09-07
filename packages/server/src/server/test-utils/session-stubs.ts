import { randomUUID } from "node:crypto";
import { vi } from "vitest";

import { getAgentProviderDefinition } from "@getpaseo/protocol/provider-manifest";

import type { ProviderSnapshotEntry } from "../agent/agent-sdk-types.js";
import type { ProviderSnapshot } from "../agent/provider-snapshot-manager.js";
import {
  GLOBAL_PROVIDER_SNAPSHOT_KEY,
  ProviderSnapshotManager,
} from "../agent/provider-snapshot-manager.js";
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
  return createStub<SessionOptions["agentStorage"]>({
    listByProviderSession: async () => [],
    listByWorkspace: async () => [],
    ...stub,
  });
}

export function asDownloadTokenStore(): SessionOptions["downloadTokenStore"] {
  return createStub<SessionOptions["downloadTokenStore"]>({});
}

export function asPushNotifications(
  stub: {
    [K in keyof SessionOptions["pushNotifications"]]?: unknown;
  } = {},
): SessionOptions["pushNotifications"] {
  return createStub<SessionOptions["pushNotifications"]>(stub);
}

export function asScheduleService(): SessionOptions["scheduleService"] {
  return createStub<SessionOptions["scheduleService"]>({});
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
  return createStub<NonNullable<SessionOptions["terminalManager"]>>({
    subscribeTerminalWorkspaceContributionChanged: () => () => {},
    ...stub,
  });
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
  [K in keyof NonNullable<SessionOptions["serviceProxy"]>]?: unknown;
}): NonNullable<SessionOptions["serviceProxy"]> {
  return createStub<NonNullable<SessionOptions["serviceProxy"]>>(stub);
}

export function asWorkspaceScriptRuntimeStore(stub: {
  [K in keyof NonNullable<SessionOptions["scriptRuntimeStore"]>]?: unknown;
}): NonNullable<SessionOptions["scriptRuntimeStore"]> {
  return createStub<NonNullable<SessionOptions["scriptRuntimeStore"]>>(stub);
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
  getSnapshot: ReturnType<typeof vi.fn<ProviderSnapshotManager["getSnapshot"]>>;
  refreshSnapshotForCwd: ReturnType<typeof vi.fn<ProviderSnapshotManager["refreshSnapshotForCwd"]>>;
  refreshSettingsSnapshot: ReturnType<
    typeof vi.fn<ProviderSnapshotManager["refreshSettingsSnapshot"]>
  >;
  warmUpSnapshotForCwd: ReturnType<typeof vi.fn<ProviderSnapshotManager["warmUpSnapshotForCwd"]>>;
  listRegisteredProviderIds: ReturnType<
    typeof vi.fn<ProviderSnapshotManager["listRegisteredProviderIds"]>
  >;
  hasProvider: ReturnType<typeof vi.fn<ProviderSnapshotManager["hasProvider"]>>;
  getProviderLabel: ReturnType<typeof vi.fn<ProviderSnapshotManager["getProviderLabel"]>>;
  getAgentManagerProviderState: ReturnType<
    typeof vi.fn<ProviderSnapshotManager["getAgentManagerProviderState"]>
  >;
  listProviders: ReturnType<typeof vi.fn<ProviderSnapshotManager["listProviders"]>>;
  getProvider: ReturnType<typeof vi.fn<ProviderSnapshotManager["getProvider"]>>;
  validateAgentConfiguration: ReturnType<
    typeof vi.fn<ProviderSnapshotManager["validateAgentConfiguration"]>
  >;
  listModels: ReturnType<typeof vi.fn<ProviderSnapshotManager["listModels"]>>;
  listModes: ReturnType<typeof vi.fn<ProviderSnapshotManager["listModes"]>>;
  resolveCreateConfig: ReturnType<typeof vi.fn<ProviderSnapshotManager["resolveCreateConfig"]>>;
  resolveDefaultModel: ReturnType<typeof vi.fn<ProviderSnapshotManager["resolveDefaultModel"]>>;
  getProviderDiagnostic: ReturnType<typeof vi.fn<ProviderSnapshotManager["getProviderDiagnostic"]>>;
  applyMutableProviderConfig: ReturnType<
    typeof vi.fn<ProviderSnapshotManager["applyMutableProviderConfig"]>
  >;
  destroy: ReturnType<typeof vi.fn<ProviderSnapshotManager["destroy"]>>;
}

export function createProviderSnapshotManagerStub(): {
  manager: ProviderSnapshotManager;
} & ProviderSnapshotManagerSpies {
  const getSnapshot = vi.fn<ProviderSnapshotManager["getSnapshot"]>((cwd) =>
    createProviderSnapshot([], cwd),
  );
  const refreshSnapshotForCwd = vi.fn<ProviderSnapshotManager["refreshSnapshotForCwd"]>(
    async () => {},
  );
  const refreshSettingsSnapshot = vi.fn<ProviderSnapshotManager["refreshSettingsSnapshot"]>(
    async () => {},
  );
  const warmUpSnapshotForCwd = vi.fn<ProviderSnapshotManager["warmUpSnapshotForCwd"]>(
    async () => {},
  );
  const listRegisteredProviderIds = vi.fn<ProviderSnapshotManager["listRegisteredProviderIds"]>(
    () => [],
  );
  const hasProvider = vi.fn<ProviderSnapshotManager["hasProvider"]>(() => false);
  const getProviderLabel = vi.fn<ProviderSnapshotManager["getProviderLabel"]>((provider) => {
    try {
      return getAgentProviderDefinition(provider).label;
    } catch {
      return provider;
    }
  });
  const getAgentManagerProviderState = vi.fn<
    ProviderSnapshotManager["getAgentManagerProviderState"]
  >(() => ({
    providerDefinitions: {},
    clients: {},
  }));
  const listProviders = vi.fn<ProviderSnapshotManager["listProviders"]>(async () => []);
  const getProvider = vi.fn<ProviderSnapshotManager["getProvider"]>(async () => {
    throw new Error("createProviderSnapshotManagerStub: getProvider not stubbed");
  });
  const validateAgentConfiguration = vi.fn<ProviderSnapshotManager["validateAgentConfiguration"]>(
    async () => [],
  );
  const listModels = vi.fn<ProviderSnapshotManager["listModels"]>(async () => []);
  const listModes = vi.fn<ProviderSnapshotManager["listModes"]>(async () => []);
  const resolveCreateConfig = vi.fn<ProviderSnapshotManager["resolveCreateConfig"]>(async () => ({
    modeId: undefined,
    featureValues: undefined,
  }));
  const resolveDefaultModel = vi.fn<ProviderSnapshotManager["resolveDefaultModel"]>(
    async () => undefined,
  );
  const getProviderDiagnostic = vi.fn<ProviderSnapshotManager["getProviderDiagnostic"]>(
    async (provider) => ({ provider, diagnostic: "No diagnostic available for this provider." }),
  );
  const applyMutableProviderConfig = vi.fn<ProviderSnapshotManager["applyMutableProviderConfig"]>(
    () => ({
      providerDefinitions: {},
      clients: {},
    }),
  );
  const on = vi.fn();
  const off = vi.fn();
  const destroy = vi.fn<ProviderSnapshotManager["destroy"]>();
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
    validateAgentConfiguration,
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
    validateAgentConfiguration,
    listModels,
    listModes,
    resolveCreateConfig,
    resolveDefaultModel,
    getProviderDiagnostic,
    applyMutableProviderConfig,
    destroy,
  };
}

export function createAgentRequestsStub(): SessionOptions["agentRequests"] {
  return {
    async create(input) {
      const agentId = randomUUID();
      await input.create(agentId);
      return agentId;
    },
    send: (input) => input.send(),
  };
}

export function createProviderSnapshot(
  entries: ProviderSnapshotEntry[],
  cwd = GLOBAL_PROVIDER_SNAPSHOT_KEY,
): ProviderSnapshot {
  return {
    cwd,
    records: entries.map((entry) => {
      const { fetchedAt: _fetchedAt, ...content } = entry;
      return { entry, contentHash: JSON.stringify(content) };
    }),
  };
}
