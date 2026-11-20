import {
  parseWorkspaceDeepLink,
  type WorkspaceDeepLinkTarget,
} from "@getpaseo/protocol/workspace-deep-link";

export function parseWorkspaceDeepLinkFromArgv(argv: string[]): WorkspaceDeepLinkTarget | null {
  for (const arg of argv) {
    const target = parseWorkspaceDeepLink(arg);
    if (target) return target;
  }
  return null;
}

export class WorkspaceNavigationInbox {
  private readonly readyWindows = new Set<number>();
  private readonly pendingByWindow = new Map<number, WorkspaceDeepLinkTarget>();

  windowLoading(webContentsId: number): void {
    this.readyWindows.delete(webContentsId);
  }

  windowReady(webContentsId: number): WorkspaceDeepLinkTarget | null {
    this.readyWindows.add(webContentsId);
    const pending = this.pendingByWindow.get(webContentsId) ?? null;
    this.pendingByWindow.delete(webContentsId);
    return pending;
  }

  deliverOrQueue(
    webContentsId: number,
    target: WorkspaceDeepLinkTarget,
  ): WorkspaceDeepLinkTarget | null {
    this.pendingByWindow.clear();
    if (this.readyWindows.has(webContentsId)) return target;
    this.pendingByWindow.set(webContentsId, target);
    return null;
  }

  removeWindow(webContentsId: number): void {
    this.readyWindows.delete(webContentsId);
    this.pendingByWindow.delete(webContentsId);
  }
}
