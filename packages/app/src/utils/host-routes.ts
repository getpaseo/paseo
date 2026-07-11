import { Buffer } from "buffer";

type NullableString = string | null | undefined;
const BASE64_WORKSPACE_ID_PREFIX = "b64_";

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

function extractHash(pathname: string): string {
  const hashIndex = pathname.indexOf("#");
  return hashIndex >= 0 ? pathname.slice(hashIndex) : "";
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

function normalizeWorkspaceId(value: string): string {
  return value.trim();
}

function isUrlSafeWorkspaceId(value: string): boolean {
  return /^[A-Za-z0-9._~-]+$/.test(value);
}

function isLegacyPathLikeWorkspaceValue(value: string): boolean {
  return value.includes("/") || value.includes("\\") || /^[A-Za-z]:[\\/]/.test(value);
}

function hasLegacyDecodeNoise(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint == null) continue;
    if (codePoint < 0x20 || codePoint === 0x7f || codePoint === 0xfffd) return true;
  }
  return false;
}

function isCleanLegacyPathDecode(value: string): boolean {
  return isLegacyPathLikeWorkspaceValue(value) && !hasLegacyDecodeNoise(value);
}

export type WorkspaceOpenIntent =
  | { kind: "agent"; agentId: string }
  | { kind: "terminal"; terminalId: string }
  | { kind: "file"; path: string }
  | { kind: "draft"; draftId: string }
  | { kind: "setup"; workspaceId: string };

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
  if (kind === "setup") {
    const workspaceId = decodeWorkspaceIdFromPathSegment(payload);
    if (!workspaceId) {
      return null;
    }
    return { kind: "setup", workspaceId };
  }

  return null;
}

export function parseHostWorkspaceOpenIntentFromPathname(
  pathname: string,
): WorkspaceOpenIntent | null {
  return parseWorkspaceOpenIntent(getHostWorkspaceOpenParamFromPathname(pathname));
}

export function getHostWorkspaceOpenParamFromPathname(pathname: string): string | null {
  const search = extractSearch(pathname);
  if (!search) {
    return null;
  }
  const open = new URLSearchParams(search).get("open");
  return parseWorkspaceOpenIntent(open) ? open : null;
}

export function encodeWorkspaceIdForPathSegment(workspaceId: string): string {
  const normalized = trimNonEmpty(workspaceId);
  if (!normalized) {
    return "";
  }
  const id = normalizeWorkspaceId(normalized);
  if (isUrlSafeWorkspaceId(id)) {
    return id;
  }
  return `${BASE64_WORKSPACE_ID_PREFIX}${toBase64UrlNoPad(id)}`;
}

export function decodeWorkspaceIdFromPathSegment(workspaceIdSegment: string): string | null {
  const normalizedSegment = trimNonEmpty(workspaceIdSegment);
  if (!normalizedSegment) {
    return null;
  }

  const decoded = trimNonEmpty(decodeSegment(normalizedSegment));
  if (!decoded) {
    return null;
  }

  if (decoded.startsWith(BASE64_WORKSPACE_ID_PREFIX)) {
    const encodedPayload = decoded.slice(BASE64_WORKSPACE_ID_PREFIX.length);
    const prefixedDecoded =
      tryDecodeBase64UrlNoPadUtf8(encodedPayload) ?? decodeBase64UrlNoPadUtf8(encodedPayload);
    return prefixedDecoded ? normalizeWorkspaceId(prefixedDecoded) : null;
  }

  // COMPAT(legacyPathWorkspaceId): IDs were path-shaped before v0.1.95. Remove when deep-link floor >= v0.2.0.
  const base64Decoded = tryDecodeBase64UrlNoPadUtf8(decoded);
  if (base64Decoded && isCleanLegacyPathDecode(base64Decoded)) {
    return normalizeWorkspaceId(base64Decoded);
  }

  const relaxedBase64Decoded = decodeBase64UrlNoPadUtf8(decoded);
  if (relaxedBase64Decoded && isCleanLegacyPathDecode(relaxedBase64Decoded)) {
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

export function stripHostWorkspaceRouteEchoSearch(route: string): string {
  const pathname = stripSearchAndHash(route);
  const selection = parseHostWorkspaceRouteFromPathname(pathname);
  const search = extractSearch(route);
  if (!selection || !search) {
    return route;
  }

  const params = new URLSearchParams(search);
  let didStrip = false;

  const serverId = params.get("serverId");
  if (serverId && trimNonEmpty(decodeSegment(serverId)) === selection.serverId) {
    params.delete("serverId");
    didStrip = true;
  }

  const workspaceId = params.get("workspaceId");
  if (workspaceId && decodeWorkspaceIdFromPathSegment(workspaceId) === selection.workspaceId) {
    params.delete("workspaceId");
    didStrip = true;
  }

  if (params.get("pop") === "true") {
    params.delete("pop");
    didStrip = true;
  }

  if (!didStrip) {
    return route;
  }

  const nextSearch = params.toString();
  const nextQuery = nextSearch ? `?${nextSearch}` : "";
  return `${pathname}${nextQuery}${extractHash(route)}`;
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

export function buildHostWorkspaceOpenRoute(
  serverId: string,
  workspaceId: string,
  openIntent: string,
) {
  const base = buildHostWorkspaceRoute(serverId, workspaceId);
  const normalizedOpenIntent = trimNonEmpty(openIntent);
  if (base === "/" || !normalizedOpenIntent) {
    return base;
  }
  return `${base}?open=${encodeURIComponent(normalizedOpenIntent)}` as const;
}

export function buildHostAgentDetailRoute(serverId: string, agentId: string, workspaceId?: string) {
  const normalizedWorkspaceId = trimNonEmpty(workspaceId);
  if (normalizedWorkspaceId) {
    const normalizedAgentId = trimNonEmpty(agentId);
    if (!normalizedAgentId) {
      return "/" as const;
    }
    return buildHostWorkspaceOpenRoute(
      serverId,
      normalizedWorkspaceId,
      `agent:${normalizedAgentId}`,
    );
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

export function buildHostOpenProjectRoute(serverId: string) {
  const base = buildHostRootRoute(serverId);
  if (base === "/") {
    return "/" as const;
  }
  return `${base}/open-project` as const;
}

export function buildHostSessionsRoute(serverId: string) {
  const base = buildHostRootRoute(serverId);
  if (base === "/") {
    return "/" as const;
  }
  return `${base}/sessions` as const;
}

export function buildSessionsRoute() {
  return "/sessions" as const;
}

export function buildSchedulesRoute() {
  return "/schedules" as const;
}

export function buildOpenProjectRoute() {
  return "/open-project" as const;
}

interface NewWorkspaceRouteOptions {
  serverId?: string;
  sourceDirectory?: string;
  displayName?: string;
  projectId?: string;
  draftId?: string;
}

function buildNewWorkspaceSearch(options: NewWorkspaceRouteOptions): string {
  const params = new URLSearchParams();
  const serverId = trimNonEmpty(options.serverId);
  if (serverId) {
    params.set("serverId", serverId);
  }
  if (options.sourceDirectory) {
    params.set("dir", options.sourceDirectory);
  }
  if (options.displayName) {
    params.set("name", options.displayName);
  }
  if (options.projectId) {
    params.set("projectId", options.projectId);
  }
  if (options.draftId) {
    params.set("draftId", options.draftId);
  }
  return params.toString();
}

export function buildNewWorkspaceRoute(options: NewWorkspaceRouteOptions = {}) {
  const query = buildNewWorkspaceSearch(options);
  if (!query) {
    return "/new" as const;
  }
  return `/new?${query}` as const;
}

export type KnownHostRouteResolution =
  | { kind: "render" }
  | { kind: "redirect"; href: ReturnType<typeof buildOpenProjectRoute> | "/welcome" };

export function resolveKnownHostRoute(input: {
  routeServerId: string | null | undefined;
  hosts: readonly { serverId: string }[];
}): KnownHostRouteResolution {
  const routeServerId = trimNonEmpty(input.routeServerId);
  if (routeServerId && input.hosts.some((host) => host.serverId === routeServerId)) {
    return { kind: "render" };
  }

  if (input.hosts.length > 0) {
    return { kind: "redirect", href: buildOpenProjectRoute() };
  }

  return { kind: "redirect", href: "/welcome" };
}

export const SETTINGS_SECTION_SLUGS = [
  "general",
  "appearance",
  "shortcuts",
  "integrations",
  "permissions",
  "diagnostics",
  "about",
] as const;

export type SettingsSectionSlug = (typeof SETTINGS_SECTION_SLUGS)[number];

export function isSettingsSectionSlug(value: string): value is SettingsSectionSlug {
  return (SETTINGS_SECTION_SLUGS as readonly string[]).includes(value);
}

export const HOST_SECTION_SLUGS = [
  "connections",
  "agents",
  "workspaces",
  "providers",
  "usage",
  "terminals",
  "host",
] as const;

export type HostSectionSlug = (typeof HOST_SECTION_SLUGS)[number];

const LEGACY_HOST_SECTION_SLUGS: Record<string, HostSectionSlug> = {
  orchestration: "agents",
  daemon: "host",
};

export function isHostSectionSlug(value: string): value is HostSectionSlug {
  return (HOST_SECTION_SLUGS as readonly string[]).includes(value);
}

export function normalizeHostSectionSlug(value: string): HostSectionSlug | null {
  if (isHostSectionSlug(value)) {
    return value;
  }
  return LEGACY_HOST_SECTION_SLUGS[value] ?? null;
}

export function buildSettingsRoute() {
  return "/settings" as const;
}

export function buildSettingsSectionRoute(section: SettingsSectionSlug) {
  return `/settings/${section}` as const;
}

export function buildSettingsAddHostRoute(intentId: string | number = "1") {
  return `/settings/general?addHost=${encodeURIComponent(String(intentId))}` as const;
}

export function buildSettingsHostRoute(serverId: string) {
  const normalized = trimNonEmpty(serverId);
  if (!normalized) {
    throw new Error("buildSettingsHostRoute requires a non-empty serverId");
  }
  return `/settings/hosts/${encodeSegment(normalized)}` as const;
}

export function buildSettingsHostSectionRoute(serverId: string, section: HostSectionSlug) {
  const normalized = trimNonEmpty(serverId);
  if (!normalized) {
    throw new Error("buildSettingsHostSectionRoute requires a non-empty serverId");
  }
  return `/settings/hosts/${encodeSegment(normalized)}/${section}` as const;
}

export function buildProjectsSettingsRoute() {
  return "/settings/projects" as const;
}

export function buildProjectSettingsRoute(projectKey: string) {
  const normalized = trimNonEmpty(projectKey);
  if (!normalized) {
    throw new Error("buildProjectSettingsRoute requires a non-empty projectKey");
  }
  return `/settings/projects/${encodeSegment(normalized)}` as const;
}
