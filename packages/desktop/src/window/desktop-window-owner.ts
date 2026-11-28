import { PendingOpenProjectStore } from "../pending-open-project-store.js";

export interface OwnedDesktopWindow {
  webContentsId: number;
  isDestroyed(): boolean;
  isVisible(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

interface DesktopWindowOwnerPort {
  create(input: {
    initialRoute: string | null;
    restoreWindowState: boolean;
    onCreated(webContentsId: number): void;
    onClosed(webContentsId: number): void;
  }): Promise<OwnedDesktopWindow>;
  windows(): OwnedDesktopWindow[];
  focusedWindow(): OwnedDesktopWindow | null;
}

export interface DesktopWindowOwner {
  openPrimary(input?: {
    initialRoute?: string | null;
    pendingProjectPath?: string | null;
  }): Promise<void>;
  openAdditional(input?: { pendingProjectPath?: string | null }): Promise<void>;
  openOrFocusLink(input: {
    initialRoute?: string;
    deliver(webContentsId: number): void;
  }): Promise<void>;
  restoreWhenActivated(): Promise<void>;
  takePendingProject(webContentsId: number): string | null;
}

export function createDesktopWindowOwner(port: DesktopWindowOwnerPort): DesktopWindowOwner {
  const pendingProjects = new PendingOpenProjectStore();
  let primaryWindowCreation: Promise<void> | null = null;
  let linkSequence = 0;

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

  const findWindow = () => {
    const focused = port.focusedWindow();
    if (focused && !focused.isDestroyed()) return focused;
    const windows = port.windows().filter((window) => !window.isDestroyed());
    return windows.find((window) => window.isVisible()) ?? windows[0];
  };

  const owner: DesktopWindowOwner = {
    openPrimary: (input = {}) => {
      primaryWindowCreation ??= open({
        initialRoute: input.initialRoute ?? null,
        pendingProjectPath: input.pendingProjectPath ?? null,
        restoreWindowState: true,
      }).finally(() => {
        primaryWindowCreation = null;
      });
      return primaryWindowCreation;
    },
    openAdditional: (input = {}) =>
      open({
        initialRoute: null,
        pendingProjectPath: input.pendingProjectPath ?? null,
        restoreWindowState: false,
      }),
    async openOrFocusLink({ initialRoute, deliver }) {
      const sequence = ++linkSequence;
      let window = findWindow();
      if (!window) {
        const opensAtTarget = !primaryWindowCreation && initialRoute !== undefined;
        await owner.openPrimary({ initialRoute: initialRoute ?? null });
        if (sequence !== linkSequence || opensAtTarget) return;
        window = findWindow();
        if (!window) return;
      }
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      deliver(window.webContentsId);
    },
    async restoreWhenActivated() {
      if (!findWindow()) await owner.openPrimary();
    },
    takePendingProject: (webContentsId) => pendingProjects.take(webContentsId),
  };
  return owner;
}
