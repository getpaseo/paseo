/**
 * Parse deep-link URLs that the OS delivers to the app. The browser-side
 * landing page for workspace shares emits links like:
 *   hubcode://join-workspace/ABC?video=0&audio=0&videoDevice=...
 *
 * We extract them from either argv (Windows/Linux cold start + second-instance)
 * or the macOS `open-url` event and forward to the renderer which navigates
 * with `expo-router` using the path+query as-is.
 */

const SCHEME_PREFIX = "hubcode://";

export interface DeepLink {
  /** Path minus the leading slash (e.g. `join-workspace/ABC`). */
  path: string;
  /** Raw query string without the leading `?`. Empty when absent. */
  query: string;
}

export function parseDeepLinkUrl(rawUrl: string): DeepLink | null {
  if (!rawUrl || !rawUrl.toLowerCase().startsWith(SCHEME_PREFIX)) return null;
  try {
    const parsed = new URL(rawUrl);
    // The URL WHATWG API treats `hubcode://join-workspace/ABC` as
    //   host=join-workspace, pathname=/ABC
    // We want the join prefix back in the path so the renderer can route it.
    const host = parsed.host;
    const pathname = parsed.pathname.replace(/^\/+/, "");
    const joined = host ? `${host}${pathname ? `/${pathname}` : ""}` : pathname;
    if (!joined) return null;
    const search = parsed.search.startsWith("?") ? parsed.search.slice(1) : parsed.search;
    return { path: joined, query: search };
  } catch {
    return null;
  }
}

export function findDeepLinkInArgv(argv: string[]): DeepLink | null {
  for (const arg of argv) {
    const parsed = parseDeepLinkUrl(arg);
    if (parsed) return parsed;
  }
  return null;
}
