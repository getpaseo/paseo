// Decides whether a browser guest may take keyboard focus from the host window.
// Page autofocus, `element.focus()` and agent-dispatched CDP clicks all focus the
// guest, so only a user mouse press counts (#4679).

const USER_PRESS_WINDOW_MS = 1000;

const lastUserPressAt = new Map<number, number>();
const lastAutomationInputAt = new Map<number, number>();

export function recordBrowserMousePress(webContentsId: number, now = Date.now()): void {
  const automationAt = lastAutomationInputAt.get(webContentsId);
  // CDP `Input.dispatchMouseEvent` reaches `before-mouse-event` like a real press.
  if (automationAt !== undefined && now - automationAt < USER_PRESS_WINDOW_MS) {
    return;
  }
  lastUserPressAt.set(webContentsId, now);
}

export function recordBrowserAutomationInput(webContentsId: number, now = Date.now()): void {
  lastAutomationInputAt.set(webContentsId, now);
  lastUserPressAt.delete(webContentsId);
}

export function isUserFocusOfBrowser(webContentsId: number, now = Date.now()): boolean {
  const pressedAt = lastUserPressAt.get(webContentsId);
  return pressedAt !== undefined && now - pressedAt < USER_PRESS_WINDOW_MS;
}

export function forgetBrowserFocusIntent(webContentsId: number): void {
  lastUserPressAt.delete(webContentsId);
  lastAutomationInputAt.delete(webContentsId);
}
