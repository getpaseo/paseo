import { vi } from "vitest";

import type { ProviderSnapshotEntry } from "../agent/agent-sdk-types.js";
import { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import type { SessionOptions } from "../session.js";
import type { SessionOutboundMessage } from "../../shared/messages.js";
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

export function asScriptRouteStore(stub: {
  [K in keyof SessionOptions["scriptRouteStore"]]?: unknown;
}): SessionOptions["scriptRouteStore"] {
  return createStub<SessionOptions["scriptRouteStore"]>(stub);
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
  getSnapshot: ReturnType<typeof vi.fn<[], ProviderSnapshotEntry[]>>;
  refreshSnapshotForCwd: ReturnType<typeof vi.fn<[], Promise<void>>>;
  refreshSettingsSnapshot: ReturnType<typeof vi.fn<[], Promise<void>>>;
  warmUpSnapshotForCwd: ReturnType<typeof vi.fn<[], Promise<void>>>;
}

export function createProviderSnapshotManagerStub(): {
  manager: ProviderSnapshotManager;
} & ProviderSnapshotManagerSpies {
  const getSnapshot = vi.fn<[], ProviderSnapshotEntry[]>(() => []);
  const refreshSnapshotForCwd = vi.fn<[], Promise<void>>(async () => {});
  const refreshSettingsSnapshot = vi.fn<[], Promise<void>>(async () => {});
  const warmUpSnapshotForCwd = vi.fn<[], Promise<void>>(async () => {});
  const on = vi.fn();
  const off = vi.fn();
  const stub = {
    getSnapshot,
    refreshSnapshotForCwd,
    refreshSettingsSnapshot,
    warmUpSnapshotForCwd,
    on,
    off,
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
  };
}
