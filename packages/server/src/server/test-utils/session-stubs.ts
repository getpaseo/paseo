import { vi } from "vitest";

import type { ProviderSnapshotEntry } from "../agent/agent-sdk-types.js";
import { ProviderSnapshotManager } from "../agent/provider-snapshot-manager.js";
import type { SessionOptions } from "../session.js";
import type { SessionOutboundMessage } from "../../shared/messages.js";

// ---------------------------------------------------------------------------
// Unsafe stub wrappers — as unknown as is ONLY here, never in scope test files
// ---------------------------------------------------------------------------

export function asSessionLogger(stub: object): SessionOptions["logger"] {
  return stub as unknown as SessionOptions["logger"];
}

export function asAgentManager(stub: object): SessionOptions["agentManager"] {
  return stub as unknown as SessionOptions["agentManager"];
}

export function asAgentStorage(stub: object): SessionOptions["agentStorage"] {
  return stub as unknown as SessionOptions["agentStorage"];
}

export function asDownloadTokenStore(): SessionOptions["downloadTokenStore"] {
  return {} as unknown as SessionOptions["downloadTokenStore"];
}

export function asPushTokenStore(): SessionOptions["pushTokenStore"] {
  return {} as unknown as SessionOptions["pushTokenStore"];
}

export function asChatService(): SessionOptions["chatService"] {
  return {} as unknown as SessionOptions["chatService"];
}

export function asScheduleService(): SessionOptions["scheduleService"] {
  return {} as unknown as SessionOptions["scheduleService"];
}

export function asLoopService(): SessionOptions["loopService"] {
  return {} as unknown as SessionOptions["loopService"];
}

export function asCheckoutDiffManager(stub: object): SessionOptions["checkoutDiffManager"] {
  return stub as unknown as SessionOptions["checkoutDiffManager"];
}

export function asDaemonConfigStore(stub: object): SessionOptions["daemonConfigStore"] {
  return stub as unknown as SessionOptions["daemonConfigStore"];
}

export function asTerminalManager(stub: object): NonNullable<SessionOptions["terminalManager"]> {
  return stub as unknown as NonNullable<SessionOptions["terminalManager"]>;
}

export function asGitHubService(stub: object): NonNullable<SessionOptions["github"]> {
  return stub as unknown as NonNullable<SessionOptions["github"]>;
}

export function asWorkspaceGitService(stub: object): SessionOptions["workspaceGitService"] {
  return stub as unknown as SessionOptions["workspaceGitService"];
}

export function asScriptRouteStore(stub: object): SessionOptions["scriptRouteStore"] {
  return stub as unknown as SessionOptions["scriptRouteStore"];
}

export function asWorkspaceScriptRuntimeStore(stub: object): SessionOptions["scriptRuntimeStore"] {
  return stub as unknown as SessionOptions["scriptRuntimeStore"];
}

// ---------------------------------------------------------------------------
// Private session access — moves the unsafe cast out of scope files
// ---------------------------------------------------------------------------

export function asSessionInternals<T>(session: unknown): T {
  return session as unknown as T;
}

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
  const manager = stub as unknown as ProviderSnapshotManager;
  return {
    manager,
    getSnapshot,
    refreshSnapshotForCwd,
    refreshSettingsSnapshot,
    warmUpSnapshotForCwd,
  };
}
