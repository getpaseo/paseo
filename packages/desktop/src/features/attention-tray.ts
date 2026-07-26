import { app, BrowserWindow, ipcMain, Menu, nativeImage, Tray } from "electron";

type AttentionStatus = "none" | "running" | "needs_input";
type AttentionItemStatus = "needs_input" | "failed" | "finished" | "running";

interface AttentionItem {
  serverId: string;
  workspaceId: string;
  agentId: string;
  workspaceLabel: string;
  sessionLabel: string;
  status: AttentionItemStatus;
}

interface AttentionState {
  status: AttentionStatus;
  items: AttentionItem[];
}

const STATUS_COLOR: Record<AttentionStatus, string> = {
  none: "#8A8A8A",
  running: "#3B82F6",
  needs_input: "#F59E0B",
};

let attentionTray: Tray | null = null;

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readAttentionItem(value: unknown): AttentionItem | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const serverId = readNonEmptyString(record.serverId);
  const workspaceId = readNonEmptyString(record.workspaceId);
  const agentId = readNonEmptyString(record.agentId);
  const workspaceLabel = readNonEmptyString(record.workspaceLabel);
  const sessionLabel = readNonEmptyString(record.sessionLabel);
  const status = record.status;
  if (
    !serverId ||
    !workspaceId ||
    !agentId ||
    !workspaceLabel ||
    !sessionLabel ||
    (status !== "needs_input" &&
      status !== "failed" &&
      status !== "finished" &&
      status !== "running")
  ) {
    return null;
  }
  return { serverId, workspaceId, agentId, workspaceLabel, sessionLabel, status };
}

function readAttentionState(value: unknown): AttentionState | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const status = record.status;
  if (status !== "none" && status !== "running" && status !== "needs_input") {
    return null;
  }
  const items = Array.isArray(record.items)
    ? record.items.map(readAttentionItem).filter((item): item is AttentionItem => item !== null)
    : [];
  return { status, items };
}

function createStatusImage(status: AttentionStatus): Electron.NativeImage {
  const color = STATUS_COLOR[status];
  const svg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 18 18">',
    `<circle cx="9" cy="9" r="7" fill="${color}"/>`,
    '<circle cx="9" cy="9" r="3" fill="white" fill-opacity="0.92"/>',
    "</svg>",
  ].join("");
  return nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
  );
}

function focusPaseoWindow(): BrowserWindow | null {
  const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed()) ?? null;
  if (!win) {
    return null;
  }
  win.show();
  if (win.isMinimized()) {
    win.restore();
  }
  win.focus();
  return win;
}

function navigateToAttentionItem(item: AttentionItem): void {
  const win = focusPaseoWindow();
  win?.webContents.send("paseo:event:notification-click", {
    data: {
      serverId: item.serverId,
      workspaceId: item.workspaceId,
      agentId: item.agentId,
    },
  });
}

function updateTray(state: AttentionState): void {
  attentionTray ??= new Tray(createStatusImage(state.status));
  attentionTray.setImage(createStatusImage(state.status));

  const waitingCount = state.items.filter(
    (item) => item.status === "needs_input" || item.status === "finished",
  ).length;
  const activeCount = state.items.length;
  let tooltip = app.name;
  if (waitingCount > 0) {
    tooltip = `${app.name}: ${waitingCount} awaiting follow-up`;
  } else if (activeCount > 0) {
    tooltip = `${app.name}: ${activeCount} active sessions`;
  }
  attentionTray.setTitle(waitingCount > 0 ? ` ${waitingCount}` : "");
  attentionTray.setToolTip(tooltip);
  attentionTray.setContextMenu(
    Menu.buildFromTemplate([
      ...(state.items.length > 0
        ? state.items.slice(0, 12).map((item) => ({
            label: `${item.workspaceLabel} — ${item.sessionLabel}`,
            click: () => navigateToAttentionItem(item),
          }))
        : [{ label: "No active sessions", enabled: false }]),
      { type: "separator" },
      { label: "Open Paseo", click: () => void focusPaseoWindow() },
    ]),
  );
  attentionTray.removeAllListeners("click");
  attentionTray.on("click", () => {
    const waitingItem = state.items.find(
      (item) => item.status === "needs_input" || item.status === "finished",
    );
    if (waitingItem) {
      navigateToAttentionItem(waitingItem);
      return;
    }
    focusPaseoWindow();
  });
}

export function registerAttentionTray(): void {
  ipcMain.handle("paseo:attention:update", (_event, rawState: unknown) => {
    if (process.platform !== "darwin") {
      return false;
    }
    const state = readAttentionState(rawState);
    if (!state) {
      return false;
    }
    updateTray(state);
    return true;
  });
}
