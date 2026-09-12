import { parseAgentDeepLink, type AgentDeepLinkTarget } from "@getpaseo/protocol/agent-deep-link";
import { parseWorkspaceRouteUrl } from "./window/workspace-route-url.js";

export function parseAgentDeepLinkFromArgv(argv: string[]): AgentDeepLinkTarget | null {
  for (const arg of argv) {
    const target = parseAgentDeepLink(arg);
    if (target) {
      return target;
    }
  }
  return null;
}

/** What one window last reported about what it shows. Strict: only what the window's
 * most recent report says is true right now — `windowLoading`/`removeWindow` clear it. */
export interface WindowView {
  visibleAgentIds: readonly string[];
  visibleWorkspaceKeys: readonly string[];
}

/** What a notification click or deep link is looking for. `workspaceId`/`agentId` are
 * null when the source (e.g. a deep link) doesn't carry that piece. */
export interface WindowNavigationTarget {
  serverId: string;
  workspaceId: string | null;
  agentId: string | null;
}

export class AgentNavigationInbox {
  private readonly readyWindows = new Set<number>();
  private readonly pendingByWindow = new Map<number, AgentDeepLinkTarget>();
  private readonly viewsByWindow = new Map<number, WindowView>();
  // Most-recently-focused first. Only a tie-break inside a tier, never a tier on its own.
  private readonly focusOrder: number[] = [];

  windowLoading(webContentsId: number): void {
    this.readyWindows.delete(webContentsId);
    this.viewsByWindow.delete(webContentsId);
  }

  windowReady(webContentsId: number): AgentDeepLinkTarget | null {
    this.readyWindows.add(webContentsId);
    const pending = this.pendingByWindow.get(webContentsId) ?? null;
    this.pendingByWindow.delete(webContentsId);
    return pending;
  }

  deliverOrQueue(webContentsId: number, target: AgentDeepLinkTarget): AgentDeepLinkTarget | null {
    if (this.readyWindows.has(webContentsId)) {
      return target;
    }
    this.pendingByWindow.set(webContentsId, target);
    return null;
  }

  removeWindow(webContentsId: number): void {
    this.readyWindows.delete(webContentsId);
    this.pendingByWindow.delete(webContentsId);
    this.viewsByWindow.delete(webContentsId);
    const index = this.focusOrder.indexOf(webContentsId);
    if (index !== -1) {
      this.focusOrder.splice(index, 1);
    }
  }

  setWindowView(webContentsId: number, view: WindowView): void {
    this.viewsByWindow.set(webContentsId, view);
  }

  clearWindowView(webContentsId: number): void {
    this.viewsByWindow.delete(webContentsId);
  }

  noteWindowFocused(webContentsId: number): void {
    const index = this.focusOrder.indexOf(webContentsId);
    if (index !== -1) {
      this.focusOrder.splice(index, 1);
    }
    this.focusOrder.unshift(webContentsId);
  }

  /**
   * Ranks `candidateIds` by how well each shows `target`, best first. A window with no
   * match at any tier is dropped, so an empty result means "none of these windows show
   * it" and the caller should fall back to its own default (today's focused/visible/first
   * order, or window creation).
   *
   * Tiers, in order: the window is already showing the agent; the window's current URL
   * (which follows in-app navigation, not just the last full load) is that workspace;
   * the window's sidebar lists that workspace. Ties within a tier go to whichever window
   * was focused more recently.
   */
  windowsShowingTarget(
    candidateIds: readonly number[],
    target: WindowNavigationTarget,
    getWindowUrl: (webContentsId: number) => string | null,
  ): number[] {
    const tierOf = (id: number): number => {
      const view = this.viewsByWindow.get(id);
      if (target.agentId && view?.visibleAgentIds.includes(target.agentId)) {
        return 1;
      }
      if (target.workspaceId) {
        const url = getWindowUrl(id);
        const route = url ? parseWorkspaceRouteUrl(url) : null;
        if (
          route &&
          route.serverId === target.serverId &&
          route.workspaceId === target.workspaceId
        ) {
          return 2;
        }
        const workspaceKey = `${target.serverId}:${target.workspaceId}`;
        if (view?.visibleWorkspaceKeys.includes(workspaceKey)) {
          return 3;
        }
      }
      return 0;
    };

    const focusRank = (id: number): number => {
      const index = this.focusOrder.indexOf(id);
      return index === -1 ? Number.MAX_SAFE_INTEGER : index;
    };

    return candidateIds
      .map((id) => ({ id, tier: tierOf(id) }))
      .filter((entry) => entry.tier > 0)
      .sort((a, b) => (a.tier !== b.tier ? a.tier - b.tier : focusRank(a.id) - focusRank(b.id)))
      .map((entry) => entry.id);
  }
}
