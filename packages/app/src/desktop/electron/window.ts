import {
  getDesktopHost,
  type DesktopWindowBridge,
  type DesktopWindowControlsOverlayUpdate,
} from "@/desktop/host";

export function getDesktopWindow(): DesktopWindowBridge | null {
  const getter = getDesktopHost()?.window?.getCurrentWindow;
  if (typeof getter !== "function") {
    return null;
  }
  try {
    return getter() ?? null;
  } catch {
    return null;
  }
}

export async function toggleDesktopMaximize(): Promise<void> {
  const win = getDesktopWindow();
  if (!win || typeof win.toggleMaximize !== "function") {
    return;
  }
  await win.toggleMaximize();
}

export async function minimizeDesktopWindow(): Promise<void> {
  const win = getDesktopWindow();
  if (!win || typeof win.minimize !== "function") {
    return;
  }
  await win.minimize();
}

export async function closeDesktopWindow(): Promise<void> {
  const win = getDesktopWindow();
  if (!win || typeof win.close !== "function") {
    return;
  }
  await win.close();
}

export async function isDesktopWindowMaximized(): Promise<boolean> {
  const win = getDesktopWindow();
  if (!win || typeof win.isMaximized !== "function") {
    return false;
  }
  return await win.isMaximized();
}

export async function isDesktopFullscreen(): Promise<boolean> {
  const win = getDesktopWindow();
  if (!win || typeof win.isFullscreen !== "function") {
    return false;
  }
  return await win.isFullscreen();
}

export async function setDesktopFullscreen(fullscreen: boolean): Promise<void> {
  const win = getDesktopWindow();
  if (!win || typeof win.setFullscreen !== "function") {
    return;
  }
  await win.setFullscreen(fullscreen);
}

export async function updateDesktopWindowControls(
  update: DesktopWindowControlsOverlayUpdate,
): Promise<void> {
  const win = getDesktopWindow();
  if (!win || typeof win.updateWindowControls !== "function") {
    return;
  }

  await win.updateWindowControls(update);
}
