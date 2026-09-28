import type {
  BrowserMirrorAction,
  BrowserMirrorEvent,
} from "@getpaseo/protocol/browser-activity/rpc-schemas";

// Daemon tab actions, fanned out to the desktop tabs that mirror them.
type MirrorListener = (event: BrowserMirrorEvent) => void;
const listeners = new Map<string, Set<MirrorListener>>();
const keyFor = (serverId: string, browserId: string) => `${serverId}\u0000${browserId}`;

export function publishBrowserMirror(serverId: string, event: BrowserMirrorEvent): void {
  for (const listener of listeners.get(keyFor(serverId, event.browserId)) ?? []) listener(event);
}

export function subscribeBrowserMirror(
  serverId: string,
  browserId: string,
  listener: MirrorListener,
): () => void {
  const key = keyFor(serverId, browserId);
  const set = listeners.get(key) ?? new Set<MirrorListener>();
  set.add(listener);
  listeners.set(key, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(key);
  };
}

/**
 * Runs inside the local page. Finds the daemon's element by its selector, else by role
 * and accessible name, and repeats the action with DOM events. Returns false when the
 * element is not on this page, which leaves the local tab as it is.
 */
export function replayMirrorAction(action: Exclude<BrowserMirrorAction, { kind: "navigate" }>) {
  interface Target {
    selector: string;
    role?: string;
    name?: string;
  }
  const byName = (target: Target): Element | null => {
    const name = target.name?.trim();
    if (!name) return null;
    const candidates = document.querySelectorAll(
      "a,button,input,textarea,select,summary,label,[role],[contenteditable='true']",
    );
    // Plain loops only: this function is stringified into the page, and a transpiled
    // for-of would call a helper that does not exist there.
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const label =
        candidate.getAttribute("aria-label") ??
        (candidate as HTMLInputElement).placeholder ??
        (candidate as HTMLElement).innerText ??
        "";
      if (label.trim() === name) return candidate;
    }
    return null;
  };
  const find = (target: Target | undefined): Element | null => {
    if (!target) return document.activeElement;
    let element: Element | null = null;
    try {
      element = document.querySelector(target.selector);
    } catch {
      element = null;
    }
    return element ?? byName(target);
  };
  const setValue = (element: Element, value: string) => {
    let proto: object = HTMLInputElement.prototype;
    if (element instanceof HTMLTextAreaElement) proto = HTMLTextAreaElement.prototype;
    if (element instanceof HTMLSelectElement) proto = HTMLSelectElement.prototype;
    // The prototype setter keeps React-controlled inputs in sync with what was typed.
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter && "value" in element) setter.call(element, value);
    else (element as HTMLElement).textContent = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const target = "target" in action ? action.target : undefined;
  const element = find(target);
  if (action.kind === "scroll") {
    if (element && target) element.scrollBy?.(action.deltaX, action.deltaY);
    else window.scrollBy(action.deltaX, action.deltaY);
    return true;
  }
  if (!element) return false;
  (element as HTMLElement).scrollIntoView?.({ block: "center" });
  (element as HTMLElement).focus?.();
  return perform(element);

  function perform(found: Element): boolean {
    switch (action.kind) {
      case "click":
        (found as HTMLElement).click();
        if (action.doubleClick) found.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
        return true;
      case "fill":
        if (action.value !== undefined) setValue(found, action.value);
        return true;
      case "select":
        setValue(found, action.value);
        return true;
      case "type":
        if (action.text !== undefined) {
          setValue(
            found,
            `${(found as HTMLInputElement).value ?? found.textContent ?? ""}${action.text}`,
          );
        }
        return true;
      case "keypress": {
        const init = { key: action.key, bubbles: true, cancelable: true };
        const proceed = found.dispatchEvent(new KeyboardEvent("keydown", init));
        found.dispatchEvent(new KeyboardEvent("keyup", init));
        // Synthetic keys do not submit forms; Enter in a field is what submits them.
        const form = (found as HTMLInputElement).form;
        if (proceed && action.key === "Enter" && form) form.requestSubmit();
        return true;
      }
      default:
        return true;
    }
  }
}

/** The evaluate source that runs replayMirrorAction on one action in the page. */
export function mirrorReplaySource(action: Exclude<BrowserMirrorAction, { kind: "navigate" }>) {
  return `() => (${replayMirrorAction.toString()})(${JSON.stringify(action)})`;
}
