let focusRestoreElement: HTMLElement | null = null;

export function setCommandCenterFocusRestoreElement(el: HTMLElement | null): void {
  focusRestoreElement = el;
}

export function takeCommandCenterFocusRestoreElement(): HTMLElement | null {
  const el = focusRestoreElement;
  focusRestoreElement = null;
  return el;
}

export function clearCommandCenterFocusRestoreElement(): void {
  focusRestoreElement = null;
}

