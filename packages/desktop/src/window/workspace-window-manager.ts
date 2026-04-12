import { BrowserWindow, ipcMain } from "electron";

type CreateWindowFn = (options?: { initialPath?: string | null }) => Promise<BrowserWindow>;

type WorkspaceWindowState = {
  windowId: number;
  isPrimary: boolean;
  workspaceOwners: Record<string, number>;
};

function normalizeWorkspaceKey(input: { serverId?: unknown; workspaceId?: unknown }): string | null {
  const serverId = typeof input.serverId === "string" ? input.serverId.trim() : "";
  const workspaceId = typeof input.workspaceId === "string" ? input.workspaceId.trim() : "";
  if (!serverId || !workspaceId) {
    return null;
  }
  return `${serverId}:${workspaceId}`;
}

function buildHostRootPath(serverId: string): string {
  return `/h/${encodeURIComponent(serverId)}`;
}

export function registerWorkspaceWindowManager(input: { createWindow: CreateWindowFn }): {
  trackWindow: (win: BrowserWindow) => void;
} {
  let primaryWindowId: number | null = null;
  const trackedWindowIds = new Set<number>();
  const workspaceOwnerByKey = new Map<string, number>();

  function listOpenWindowIds(): number[] {
    return BrowserWindow.getAllWindows().map((win) => win.webContents.id);
  }

  function snapshotForWindow(windowId: number): WorkspaceWindowState {
    return {
      windowId,
      isPrimary: primaryWindowId === windowId,
      workspaceOwners: Object.fromEntries(workspaceOwnerByKey),
    };
  }

  function broadcastState(): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("paseo:event:window-workspace-state", snapshotForWindow(win.webContents.id));
    }
  }

  function ensurePrimaryWindow(): void {
    if (primaryWindowId !== null && trackedWindowIds.has(primaryWindowId)) {
      return;
    }
    primaryWindowId = listOpenWindowIds()[0] ?? null;
  }

  function releaseWindowOwnership(windowId: number): void {
    for (const [workspaceKey, ownerWindowId] of workspaceOwnerByKey.entries()) {
      if (ownerWindowId === windowId) {
        workspaceOwnerByKey.delete(workspaceKey);
      }
    }
  }

  function trackWindow(win: BrowserWindow): void {
    const windowId = win.webContents.id;
    if (trackedWindowIds.has(windowId)) {
      return;
    }
    trackedWindowIds.add(windowId);
    ensurePrimaryWindow();
    if (primaryWindowId === null) {
      primaryWindowId = windowId;
    }

    win.on("closed", () => {
      trackedWindowIds.delete(windowId);
      releaseWindowOwnership(windowId);
      if (primaryWindowId === windowId) {
        primaryWindowId = listOpenWindowIds()[0] ?? null;
      }
      ensurePrimaryWindow();
      broadcastState();
    });

    broadcastState();
  }

  ipcMain.handle("paseo:window:getWorkspaceState", (event) => {
    ensurePrimaryWindow();
    return snapshotForWindow(event.sender.id);
  });

  ipcMain.handle(
    "paseo:window:claimWorkspace",
    (event, payload?: { serverId?: unknown; workspaceId?: unknown }) => {
      const workspaceKey = normalizeWorkspaceKey(payload ?? {});
      if (!workspaceKey) {
        return false;
      }
      workspaceOwnerByKey.set(workspaceKey, event.sender.id);
      broadcastState();
      return true;
    },
  );

  ipcMain.handle(
    "paseo:window:moveWorkspaceToNewWindow",
    async (_event, payload?: { serverId?: unknown; workspaceId?: unknown }) => {
      const workspaceKey = normalizeWorkspaceKey(payload ?? {});
      const serverId = typeof payload?.serverId === "string" ? payload.serverId.trim() : "";
      if (!workspaceKey || !serverId) {
        return false;
      }

      const targetWindow = await input.createWindow({
        initialPath: buildHostRootPath(serverId),
      });
      workspaceOwnerByKey.set(workspaceKey, targetWindow.webContents.id);
      broadcastState();
      return true;
    },
  );

  return {
    trackWindow,
  };
}
