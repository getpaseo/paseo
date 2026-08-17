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

export async function isDesktopFullscreen(): Promise<boolean> {
  const win = getDesktopWindow();
  if (!win || typeof win.isFullscreen !== "function") {
    return false;
  }
  return await win.isFullscreen();
}

/** The window's page zoom factor, or null when the host cannot report one. */
export async function readDesktopZoomFactor(): Promise<number | null> {
  const win = getDesktopWindow();
  if (!win || typeof win.getZoomFactor !== "function") {
    return null;
  }
  const zoomFactor = await win.getZoomFactor();
  return typeof zoomFactor === "number" && Number.isFinite(zoomFactor) && zoomFactor > 0
    ? zoomFactor
    : null;
}

export async function subscribeToDesktopZoomChanged(
  handler: () => void,
): Promise<(() => void) | null> {
  const win = getDesktopWindow();
  if (!win || typeof win.onZoomChanged !== "function") {
    return null;
  }
  return await win.onZoomChanged(handler);
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
