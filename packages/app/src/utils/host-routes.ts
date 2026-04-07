import { Buffer } from "buffer";

type NullableString = string | null | undefined;

function stripSearchAndHash(pathname: string): string {
  const hashIndex = pathname.indexOf("#");
  const queryIndex = pathname.indexOf("?");
  const end = [hashIndex, queryIndex]
    .filter((index) => index >= 0)
    .reduce((min, index) => Math.min(min, index), pathname.length);
  return pathname.slice(0, end);
}

function extractSearch(pathname: string): string {
  const queryIndex = pathname.indexOf("?");
  if (queryIndex < 0) {
    return "";
  }
  const hashIndex = pathname.indexOf("#", queryIndex);
  return hashIndex >= 0
    ? pathname.slice(queryIndex + 1, hashIndex)
    : pathname.slice(queryIndex + 1);
}

function trimNonEmpty(value: NullableString): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function toBase64UrlNoPad(input: string): string {
  return Buffer.from(input, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeBase64UrlNoPadUtf8(input: string): string | null {
  const normalized = input.trim();
  if (normalized.length === 0) {
    return null;
  }
  if (!/^[A-Za-z0-9_-]+$/.test(normalized)) {
    return null;
  }

  const base64 = normalized.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");

  let decoded: string;
  try {
    decoded = Buffer.from(padded, "base64").toString("utf8");
  } catch {
    return null;
  }

  return decoded;
}

function tryDecodeBase64UrlNoPadUtf8(input: string): string | null {
  const normalized = input.trim();
  const decoded = decodeBase64UrlNoPadUtf8(normalized);
  if (!decoded) {
    return null;
  }

  // Validate via round-trip to avoid false positives ("workspace-1" etc).
  if (toBase64UrlNoPad(decoded) !== normalized) {
    return null;
  }

  return decoded;
}

function isPathLikeWorkspaceIdentity(value: string): boolean {
  return value.includes("/") || value.includes("\\") || /^[A-Za-z]:[\\/]/.test(value);
}

function normalizeWorkspaceId(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

export type WorkspaceOpenIntent =
  | { kind: "agent"; agentId: string }
  | { kind: "terminal"; terminalId: string }
  | { kind: "file"; path: string }
  | { kind: "draft"; draftId: string };

export function parseWorkspaceOpenIntent(
  value: string | null | undefined,
): WorkspaceOpenIntent | null {
  const normalized = trimNonEmpty(value);
  if (!normalized) {
    return null;
  }

  const separator = normalized.indexOf(":");
  if (separator <= 0 || separator >= normalized.length - 1) {
    return null;
  }

  const kind = normalized.slice(0, separator);
  const payload = trimNonEmpty(normalized.slice(separator + 1));
  if (!payload) {
    return null;
  }

  if (kind === "agent") {
    return { kind: "agent", agentId: payload };
  }
  if (kind === "terminal") {
    return { kind: "terminal", terminalId: payload };
  }
  if (kind === "draft") {
    return { kind: "draft", draftId: payload };
  }
  if (kind === "file") {
    const decodedPath = decodeFilePathFromPathSegment(payload);
    if (!decodedPath) {
      return null;
    }
    return { kind: "file", path: decodedPath };
  }

  return null;
}

export function parseHostWorkspaceOpenIntentFromPathname(
  pathname: string,
): WorkspaceOpenIntent | null {
  const search = extractSearch(pathname);
  if (!search) {
    return null;
  }
  return parseWorkspaceOpenIntent(new URLSearchParams(search).get("open"));
}

export function encodeWorkspaceIdForPathSegment(workspaceId: string): string {
  const normalized = trimNonEmpty(workspaceId);
  if (!normalized) {
    return "";
  }
  return toBase64UrlNoPad(normalizeWorkspaceId(normalized));
}

export function decodeWorkspaceIdFromPathSegment(workspaceIdSegment: string): string | null {
  const normalizedSegment = trimNonEmpty(workspaceIdSegment);
  if (!normalizedSegment) {
    return null;
  }

  // Decode %2F etc first (legacy scheme), but keep the raw segment to decide if base64 applies.
  const decoded = trimNonEmpty(decodeSegment(normalizedSegment));
  if (!decoded) {
    return null;
  }

  // Legacy: if it already looks like a path after decoding, keep it.
  if (decoded.includes("/") || decoded.includes("\\")) {
    return normalizeWorkspaceId(decoded);
  }

  const base64Decoded = tryDecodeBase64UrlNoPadUtf8(decoded);
  if (base64Decoded) {
    return normalizeWorkspaceId(base64Decoded);
  }

  // Some older links use non-canonical base64url (non-zero pad bits). Accept
  // decoded values only when they clearly represent filesystem paths.
  const relaxedBase64Decoded = decodeBase64UrlNoPadUtf8(decoded);
  if (relaxedBase64Decoded && isPathLikeWorkspaceIdentity(relaxedBase64Decoded)) {
    return normalizeWorkspaceId(relaxedBase64Decoded);
  }

  return normalizeWorkspaceId(decoded);
}

export function encodeFilePathForPathSegment(filePath: string): string {
  const normalized = trimNonEmpty(filePath);
  if (!normalized) {
    return "";
  }
  return toBase64UrlNoPad(normalized);
}

export function decodeFilePathFromPathSegment(filePathSegment: string): string | null {
  const normalizedSegment = trimNonEmpty(filePathSegment);
  if (!normalizedSegment) {
    return null;
  }
  const decoded = trimNonEmpty(decodeSegment(normalizedSegment));
  if (!decoded) {
    return null;
  }
  return tryDecodeBase64UrlNoPadUtf8(decoded);
}

export function parseServerIdFromPathname(pathname: string): string | null {
  const pathOnly = stripSearchAndHash(pathname);
  const match = pathOnly.match(/^\/h\/([^/]+)(?:\/|$)/);
  if (!match) {
    return null;
  }
  const raw = match[1];
  if (!raw) {
    return null;
  }
  return trimNonEmpty(decodeSegment(raw));
}

export function parseHostAgentRouteFromPathname(
  pathname: string,
): { serverId: string; agentId: string } | null {
  const pathOnly = stripSearchAndHash(pathname);
  const match = pathOnly.match(/^\/h\/([^/]+)\/agent\/([^/]+)(?:\/|$)/);
  if (!match) {
    return null;
  }

  const [, encodedServerId, encodedAgentId] = match;
  if (!encodedServerId || !encodedAgentId) {
    return null;
  }

  const serverId = trimNonEmpty(decodeSegment(encodedServerId));
  const agentId = trimNonEmpty(decodeSegment(encodedAgentId));
  if (!serverId || !agentId) {
    return null;
  }

  return { serverId, agentId };
}

export function parseHostWorkspaceRouteFromPathname(
  pathname: string,
): { serverId: string; workspaceId: string } | null {
  const pathOnly = stripSearchAndHash(pathname);
  const match = pathOnly.match(/^\/h\/([^/]+)\/workspace\/([^/]+)\/?$/);
  if (!match) {
    return null;
  }

  const serverId = trimNonEmpty(decodeSegment(match[1]));
  if (!serverId) {
    return null;
  }

  const rawWorkspaceId = match[2];
  const workspaceId = decodeWorkspaceIdFromPathSegment(rawWorkspaceId);
  if (!workspaceId) {
    return null;
  }
  return { serverId, workspaceId };
}

export function buildHostWorkspaceRoute(serverId: string, workspaceId: string) {
  const normalizedServerId = trimNonEmpty(serverId);
  const normalizedWorkspaceId = trimNonEmpty(workspaceId);
  if (!normalizedServerId || !normalizedWorkspaceId) {
    return "/" as const;
  }
  const encodedWorkspaceId = encodeWorkspaceIdForPathSegment(normalizedWorkspaceId);
  if (!encodedWorkspaceId) {
    return "/" as const;
  }
  return `/h/${encodeSegment(normalizedServerId)}/workspace/${encodeSegment(encodedWorkspaceId)}` as const;
}

export function buildHostAgentDetailRoute(
  serverId: string,
  agentId: string,
  workspaceId?: string,
) {
  const normalizedWorkspaceId = trimNonEmpty(workspaceId);
  if (normalizedWorkspaceId) {
    const normalizedAgentId = trimNonEmpty(agentId);
    if (!normalizedAgentId) {
      return "/" as const;
    }
    const base = buildHostWorkspaceRoute(serverId, normalizedWorkspaceId);
    if (base === "/") {
      return "/" as const;
    }
    return `${base}?open=${encodeURIComponent(`agent:${normalizedAgentId}`)}` as const;
  }
  const normalizedServerId = trimNonEmpty(serverId);
  const normalizedAgentId = trimNonEmpty(agentId);
  if (!normalizedServerId || !normalizedAgentId) {
    return "/" as const;
  }
  return `${buildHostRootRoute(normalizedServerId)}/agent/${encodeSegment(normalizedAgentId)}` as const;
}

export function buildHostRootRoute(serverId: string) {
  const normalized = trimNonEmpty(serverId);
  if (!normalized) {
    return "/" as const;
  }
  return `/h/${encodeSegment(normalized)}` as const;
}

export function buildHostSessionsRoute(serverId: string) {
  const base = buildHostRootRoute(serverId);
  if (base === "/") {
    return "/" as const;
  }
  return `${base}/sessions` as const;
}

export function buildHostOpenProjectRoute(serverId: string) {
  const base = buildHostRootRoute(serverId);
  if (base === "/") {
    return "/" as const;
  }
  return `${base}/open-project` as const;
}

export function buildHostSettingsRoute(serverId: string) {
  const base = buildHostRootRoute(serverId);
  if (base === "/") {
    return "/" as const;
  }
  return `${base}/settings` as const;
}

export function mapPathnameToServer(pathname: string, nextServerId: string) {
  const normalized = trimNonEmpty(nextServerId);
  if (!normalized) {
    return "/" as const;
  }

  const suffix = pathname.replace(/^\/h\/[^/]+\/?/, "");
  const base = buildHostRootRoute(normalized);
  if (suffix.startsWith("settings")) {
    return `${base}/settings` as const;
  }
  if (suffix.startsWith("sessions")) {
    return `${base}/sessions` as const;
  }
  if (suffix.startsWith("open-project")) {
    return `${base}/open-project` as const;
  }
  const workspaceRoute = parseHostWorkspaceRouteFromPathname(pathname);
  if (workspaceRoute) {
    return buildHostWorkspaceRoute(normalized, workspaceRoute.workspaceId);
  }
  if (suffix.startsWith("agent/")) {
    return `${base}/${suffix}` as const;
  }
  return base;
}
