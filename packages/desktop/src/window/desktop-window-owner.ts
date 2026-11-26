import { PendingOpenProjectStore } from "../pending-open-project-store.js";

export interface OwnedDesktopWindow<TAgentTarget> {
  webContentsId: number;
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  sendAgent(target: TAgentTarget): void;
}

interface DesktopWindowOwnerPort<TAgentTarget> {
  create(input: {
    initialRoute: string | null;
    restoreWindowState: boolean;
    onCreated(webContentsId: number): void;
    onClosed(webContentsId: number): void;
  }): Promise<OwnedDesktopWindow<TAgentTarget>>;
  windows(): OwnedDesktopWindow<TAgentTarget>[];
  focusedWindow(): OwnedDesktopWindow<TAgentTarget> | null;
  agentRoute(target: TAgentTarget): string;
  deliverAgent(webContentsId: number, target: TAgentTarget): TAgentTarget | null;
}

export interface DesktopWindowOwner<TAgentTarget> {
  openPrimary(input?: {
    initialRoute?: string | null;
    pendingProjectPath?: string | null;
  }): Promise<void>;
  openAdditional(input?: { pendingProjectPath?: string | null }): Promise<void>;
  openOrFocusAgent(target: TAgentTarget): Promise<void>;
  /** Brings a window to the front, or opens the primary window when none is open. */
  openOrFocusWindow(): Promise<OwnedDesktopWindow<TAgentTarget> | null>;
  restoreWhenActivated(): Promise<void>;
  takePendingProject(webContentsId: number): string | null;
}

export function createDesktopWindowOwner<TAgentTarget>(
  port: DesktopWindowOwnerPort<TAgentTarget>,
): DesktopWindowOwner<TAgentTarget> {
  const pendingProjects = new PendingOpenProjectStore();
  let windowCreation: Promise<void> | null = null;

  function frontWindow(): OwnedDesktopWindow<TAgentTarget> | null {
    const windows = port.windows();
    const window =
      port.focusedWindow() ?? windows.find((candidate) => candidate.isVisible()) ?? windows[0];
    return window && !window.isDestroyed() ? window : null;
  }

  function bringToFront(window: OwnedDesktopWindow<TAgentTarget>): void {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  // Links that arrive together while no window is open share one new window.
  function openFrontWindow(initialRoute: string | null): Promise<void> {
    windowCreation = owner.openPrimary({ initialRoute }).finally(() => {
      windowCreation = null;
    });
    return windowCreation;
  }

  const open = async (input: {
    initialRoute: string | null;
    pendingProjectPath: string | null;
    restoreWindowState: boolean;
  }): Promise<void> => {
    await port.create({
      initialRoute: input.initialRoute,
      restoreWindowState: input.restoreWindowState,
      onCreated: (webContentsId) => pendingProjects.set(webContentsId, input.pendingProjectPath),
      onClosed: (webContentsId) => pendingProjects.delete(webContentsId),
    });
  };

  const owner: DesktopWindowOwner<TAgentTarget> = {
    openPrimary: (input = {}) =>
      open({
        initialRoute: input.initialRoute ?? null,
        pendingProjectPath: input.pendingProjectPath ?? null,
        restoreWindowState: true,
      }),
    openAdditional: (input = {}) =>
      open({
        initialRoute: null,
        pendingProjectPath: input.pendingProjectPath ?? null,
        restoreWindowState: false,
      }),
    async openOrFocusAgent(target) {
      const window = frontWindow();
      if (!window) {
        if (!windowCreation) {
          await openFrontWindow(port.agentRoute(target));
          return;
        }
        await windowCreation;
        await owner.openOrFocusAgent(target);
        return;
      }
      bringToFront(window);
      const deliverable = port.deliverAgent(window.webContentsId, target);
      if (deliverable) window.sendAgent(deliverable);
    },
    async openOrFocusWindow() {
      const window = frontWindow();
      if (window) {
        bringToFront(window);
        return window;
      }
      await (windowCreation ?? openFrontWindow(null));
      return frontWindow();
    },
    async restoreWhenActivated() {
      if (port.windows().length === 0) await owner.openPrimary();
    },
    takePendingProject: (webContentsId) => pendingProjects.take(webContentsId),
  };
  return owner;
}
