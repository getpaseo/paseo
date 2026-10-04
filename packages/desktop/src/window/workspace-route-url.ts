/**
 * Parses a window's current URL into the workspace it names, if any.
 *
 * Both loading modes put the same route path in the URL: packaged windows load
 * `paseo://app/h/<serverId>/workspace/<workspaceId>` and dev windows load the same
 * route off the Expo dev server (`http://localhost:8081/h/<serverId>/workspace/<id>`).
 * `webContents.getURL()` follows in-app `history.pushState` navigation under both, so
 * this is a live read of which workspace a window is showing, not a snapshot from the
 * last full load.
 */

export interface WorkspaceRouteMatch {
  serverId: string;
  workspaceId: string;
}

const WORKSPACE_ROUTE_PATTERN = /^\/h\/([^/]+)\/workspace\/([^/]+)\/?$/;

export function parseWorkspaceRouteUrl(url: string): WorkspaceRouteMatch | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const match = WORKSPACE_ROUTE_PATTERN.exec(parsed.pathname);
  if (!match) {
    return null;
  }

  const serverId = decodeURIComponent(match[1]);
  const workspaceId = decodeURIComponent(match[2]);
  if (!serverId || !workspaceId) {
    return null;
  }

  return { serverId, workspaceId };
}
