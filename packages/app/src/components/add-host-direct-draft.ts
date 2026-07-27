import { normalizeDaemonListenEndpoint } from "@/utils/daemon-listen-endpoint";
import { parseHostPort } from "@/utils/daemon-endpoints";

export interface DirectConnectionDraft {
  host: string;
  port: string;
  useTls: boolean;
  password: string;
}

export interface DirectConnectionHint {
  listen: string;
  useTls?: boolean;
}

export interface PageLocationHint {
  hostname: string;
  port: string;
  protocol: string;
}

export const DEFAULT_DIRECT_HOST = "localhost";
export const DEFAULT_DIRECT_PORT = "6767";

export function createDefaultDirectConnectionDraft(): DirectConnectionDraft {
  return {
    host: DEFAULT_DIRECT_HOST,
    port: DEFAULT_DIRECT_PORT,
    useTls: false,
    password: "",
  };
}

/**
 * Build the initial Add Host draft (editable defaults only — never locked).
 *
 * Same-origin daemon web UI injects `__PASEO_INITIAL_DAEMON_CONNECTION__`.
 * When that hint is present, prefer the browser's current page location so
 * HTTPS reverse proxies (nip.io / :443) prefill Host/Port/TLS. The user can
 * still change these fields to connect to an external host. Fall back to the
 * injected listen string, then localhost:6767.
 */
export function resolveInitialDirectConnectionDraft(
  hint: DirectConnectionHint | null | undefined,
  pageLocation?: PageLocationHint | null,
): DirectConnectionDraft {
  if (hint && pageLocation?.hostname) {
    return directConnectionDraftFromPageLocation(pageLocation);
  }
  if (!hint) {
    return createDefaultDirectConnectionDraft();
  }
  return directConnectionDraftFromHint(hint);
}

export function directConnectionDraftFromHint(hint: DirectConnectionHint): DirectConnectionDraft {
  const useTls = hint.useTls === true;
  const endpoint = normalizeDaemonListenEndpoint(hint.listen, useTls);
  if (!endpoint) {
    return createDefaultDirectConnectionDraft();
  }
  const parsed = parseHostPort(endpoint);
  return {
    host: parsed.host,
    port: String(parsed.port),
    useTls,
    password: "",
  };
}

export function directConnectionDraftFromPageLocation(
  pageLocation: PageLocationHint,
): DirectConnectionDraft {
  const useTls = pageLocation.protocol === "https:";
  const hostname = pageLocation.hostname.trim();
  if (!hostname) {
    return createDefaultDirectConnectionDraft();
  }
  const listen = pageLocation.port.trim() ? `${hostname}:${pageLocation.port.trim()}` : hostname;
  const endpoint =
    normalizeDaemonListenEndpoint(listen, useTls) ?? `${hostname}:${DEFAULT_DIRECT_PORT}`;
  const parsed = parseHostPort(endpoint);
  return {
    host: parsed.host,
    port: String(parsed.port),
    useTls,
    password: "",
  };
}

/**
 * Empty host falls back to the provided default (same-origin page when
 * available), otherwise localhost.
 */
export function normalizeDirectConnectionDraft(
  draft: DirectConnectionDraft,
  emptyHostFallback: DirectConnectionDraft = createDefaultDirectConnectionDraft(),
): DirectConnectionDraft {
  const host = draft.host.trim();
  if (!host) {
    return {
      host: emptyHostFallback.host,
      port: draft.port.trim() || emptyHostFallback.port,
      useTls: draft.useTls,
      password: draft.password,
    };
  }
  return {
    host,
    port: draft.port.trim() || emptyHostFallback.port || DEFAULT_DIRECT_PORT,
    useTls: draft.useTls,
    password: draft.password,
  };
}

export function readPageLocationHint(): PageLocationHint | null {
  const location = resolveBrowserLocation();
  if (!location || typeof location.hostname !== "string" || !location.hostname) {
    return null;
  }
  return {
    hostname: location.hostname,
    port: typeof location.port === "string" ? location.port : "",
    protocol: typeof location.protocol === "string" ? location.protocol : "http:",
  };
}

function resolveBrowserLocation(): PageLocationHint | null {
  if (typeof globalThis === "undefined") {
    return null;
  }
  const fromGlobal = (globalThis as { location?: PageLocationHint }).location;
  if (fromGlobal && typeof fromGlobal.hostname === "string") {
    return fromGlobal;
  }
  const fromWindow = (globalThis as { window?: { location?: PageLocationHint } }).window?.location;
  if (fromWindow && typeof fromWindow.hostname === "string") {
    return fromWindow;
  }
  return null;
}
