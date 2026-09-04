import path from "node:path";

import type { AgentMetadata } from "../../agent-sdk-types.js";
import type { HerdrAgent } from "./herdr-client.js";

export const HERDR_ATTACHED_PI_RUNTIME = "herdr-attached";
const HERDR_ATTACHED_PI_HANDLE_PREFIX = "herdr-attached:";

export interface HerdrAttachedPiMetadata extends AgentMetadata {
  runtime: typeof HERDR_ATTACHED_PI_RUNTIME;
  herdrSession: string;
  herdrTarget: string;
  herdrAlias?: string;
  herdrPaneId?: string;
  nativeSessionId: string;
  nativeSessionFile: string;
  cwd: string;
  lastSyncedNativeEntryId?: string;
}

export type HerdrAttachedPiValidationResult = { ok: true } | { ok: false; reason: string };

export function encodeHerdrAttachedPiHandle(metadata: HerdrAttachedPiMetadata): string {
  const payload = Buffer.from(JSON.stringify(toHerdrAttachedPiIdentity(metadata))).toString(
    "base64url",
  );
  return `${HERDR_ATTACHED_PI_HANDLE_PREFIX}${payload}`;
}

function toHerdrAttachedPiIdentity(
  metadata: HerdrAttachedPiMetadata,
): Omit<HerdrAttachedPiMetadata, "lastSyncedNativeEntryId"> {
  const { lastSyncedNativeEntryId: _lastSyncedNativeEntryId, ...identity } =
    toPersistedHerdrAttachedPiMetadata(metadata);
  return identity;
}

export function parseHerdrAttachedPiHandle(handle: string): HerdrAttachedPiMetadata | null {
  if (!handle.startsWith(HERDR_ATTACHED_PI_HANDLE_PREFIX)) {
    return null;
  }
  try {
    const decoded = JSON.parse(
      Buffer.from(handle.slice(HERDR_ATTACHED_PI_HANDLE_PREFIX.length), "base64url").toString(
        "utf8",
      ),
    ) as unknown;
    return parseHerdrAttachedPiMetadata(decoded);
  } catch {
    return null;
  }
}

export function parseHerdrAttachedPiMetadata(
  metadata: AgentMetadata | unknown,
): HerdrAttachedPiMetadata | null {
  if (!isRecord(metadata) || metadata.runtime !== HERDR_ATTACHED_PI_RUNTIME) {
    return null;
  }

  const herdrSession = readString(metadata.herdrSession);
  const herdrTarget = readString(metadata.herdrTarget);
  const nativeSessionId = readString(metadata.nativeSessionId);
  const nativeSessionFile = readString(metadata.nativeSessionFile);
  const cwd = readString(metadata.cwd);
  if (!herdrSession || !herdrTarget || !nativeSessionId || !nativeSessionFile || !cwd) {
    return null;
  }

  const herdrAlias = readString(metadata.herdrAlias);
  const herdrPaneId = readString(metadata.herdrPaneId);
  const lastSyncedNativeEntryId = readString(metadata.lastSyncedNativeEntryId);
  return {
    runtime: HERDR_ATTACHED_PI_RUNTIME,
    herdrSession,
    herdrTarget,
    ...(herdrAlias ? { herdrAlias } : {}),
    ...(herdrPaneId ? { herdrPaneId } : {}),
    nativeSessionId,
    nativeSessionFile,
    cwd,
    ...(lastSyncedNativeEntryId ? { lastSyncedNativeEntryId } : {}),
  };
}

export function toPersistedHerdrAttachedPiMetadata(
  metadata: HerdrAttachedPiMetadata,
): HerdrAttachedPiMetadata {
  return {
    runtime: HERDR_ATTACHED_PI_RUNTIME,
    herdrSession: metadata.herdrSession,
    herdrTarget: metadata.herdrTarget,
    ...(metadata.herdrAlias ? { herdrAlias: metadata.herdrAlias } : {}),
    ...(metadata.herdrPaneId ? { herdrPaneId: metadata.herdrPaneId } : {}),
    nativeSessionId: metadata.nativeSessionId,
    nativeSessionFile: metadata.nativeSessionFile,
    cwd: metadata.cwd,
    ...(metadata.lastSyncedNativeEntryId
      ? { lastSyncedNativeEntryId: metadata.lastSyncedNativeEntryId }
      : {}),
  };
}

export function validateHerdrAttachedPiTarget(
  expected: HerdrAttachedPiMetadata,
  actual: HerdrAgent,
): HerdrAttachedPiValidationResult {
  if (!isPiKind(actual.kind)) {
    return { ok: false, reason: `Herdr target ${expected.herdrTarget} is not a Pi agent` };
  }

  if (!matchesExpectedTarget(expected, actual)) {
    return { ok: false, reason: `Herdr target ${expected.herdrTarget} no longer matches` };
  }

  if (!actual.nativeSessionId || actual.nativeSessionId !== expected.nativeSessionId) {
    return {
      ok: false,
      reason: `Native Pi session changed for Herdr target ${expected.herdrTarget}`,
    };
  }

  if (!actual.nativeSessionFile || actual.nativeSessionFile !== expected.nativeSessionFile) {
    return {
      ok: false,
      reason: `Native Pi session file changed for Herdr target ${expected.herdrTarget}`,
    };
  }

  if (!actual.cwd || normalizeCwd(actual.cwd) !== normalizeCwd(expected.cwd)) {
    return {
      ok: false,
      reason: `Working directory changed for Herdr target ${expected.herdrTarget}`,
    };
  }

  return { ok: true };
}

export function isAttachableHerdrPiAgent(agent: HerdrAgent): boolean {
  return (
    isPiKind(agent.kind) &&
    Boolean(agent.target) &&
    Boolean(agent.cwd) &&
    Boolean(agent.nativeSessionId) &&
    Boolean(agent.nativeSessionFile)
  );
}

function matchesExpectedTarget(expected: HerdrAttachedPiMetadata, actual: HerdrAgent): boolean {
  const accepted = new Set(
    [expected.herdrTarget, expected.herdrAlias, expected.herdrPaneId].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    ),
  );
  return [actual.target, actual.name, actual.paneId, actual.id].some(
    (value) => typeof value === "string" && accepted.has(value),
  );
}

function isPiKind(kind: string | null): boolean {
  return kind?.toLowerCase() === "pi";
}

function normalizeCwd(cwd: string): string {
  return path.resolve(cwd);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
