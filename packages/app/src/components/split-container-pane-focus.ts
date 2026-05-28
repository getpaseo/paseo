const INTERACTIVE_TARGET_SELECTOR = [
  "a",
  "button",
  "select",
  "[role='button']",
  "[role='link']",
  "[contenteditable='true']",
  "[data-paseo-pane-focus-exempt='true']",
].join(", ");

export function shouldFocusPaneFromEventTarget(target: EventTarget | null): boolean {
  const candidate = target as unknown as { closest?: (selector: string) => Element | null } | null;
  if (!candidate || typeof candidate.closest !== "function") {
    return true;
  }

  return !candidate.closest(INTERACTIVE_TARGET_SELECTOR);
}
