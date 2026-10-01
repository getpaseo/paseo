import type {
  BrowserMirrorAction,
  BrowserMirrorEvent,
} from "@getpaseo/protocol/browser-activity/rpc-schemas";
import { BrowserMirrorActionSchema } from "@getpaseo/protocol/browser-activity/rpc-schemas";

// Daemon tab actions, fanned out to the desktop tabs that mirror them.
type MirrorListener = (event: BrowserMirrorEvent) => void;
const listeners = new Map<string, Set<MirrorListener>>();
const history = new Map<string, BrowserMirrorEvent[]>();
const keyFor = (serverId: string, browserId: string) => `${serverId}\u0000${browserId}`;

export function publishBrowserMirror(serverId: string, event: BrowserMirrorEvent): void {
  const key = keyFor(serverId, event.browserId);
  const events = history.get(key) ?? [];
  if (event.at <= (events.at(-1)?.at ?? 0)) return;
  if (event.action.kind === "navigate") events.length = 0;
  events.push(event);
  if (events.length > 201) events.splice(1, 1);
  history.set(key, events);
  for (const listener of listeners.get(key) ?? []) listener(event);
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
  for (const event of history.get(key) ?? []) listener(event);
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(key);
  };
}

/** A retained desktop page resumes once; a new native WebView supplies a fresh cursor. */
export function subscribeBrowserMirrorReplay(input: {
  serverId: string;
  browserId: string;
  cursor: { at: number };
  replay: (action: BrowserMirrorAction) => Promise<void>;
  onError: (error: unknown) => void;
}): () => void {
  let stopped = false;
  let failed = false;
  let queue = Promise.resolve(undefined);
  const unsubscribe = subscribeBrowserMirror(input.serverId, input.browserId, (event) => {
    queue = queue.then(async () => {
      if (stopped || event.at <= input.cursor.at) return undefined;
      if (event.origin === MIRROR_ORIGIN) {
        input.cursor.at = event.at;
        return undefined;
      }
      if (failed && event.action.kind !== "navigate") return undefined;
      try {
        await input.replay(event.action);
        input.cursor.at = event.at;
        failed = false;
      } catch (error) {
        failed = true;
        input.onError(error);
      }
      return undefined;
    });
  });
  return () => {
    stopped = true;
    unsubscribe();
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
      const role =
        candidate.getAttribute("role") ??
        (
          {
            BUTTON: "button",
            A: "link",
            INPUT: "textbox",
            TEXTAREA: "textbox",
            SELECT: "combobox",
          } as Record<string, string>
        )[candidate.tagName];
      if (label.trim() === name && (!target.role || target.role === role)) return candidate;
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

/** Wait for asynchronously rendered controls in either Electron or a native WebView. */
export function mirrorReplayReadySource(
  action: Exclude<BrowserMirrorAction, { kind: "navigate" }>,
) {
  return `async () => {
    const replay = ${mirrorReplaySource(action)};
    const deadline = Date.now() + 5000;
    do {
      if (replay()) return true;
      await new Promise(resolve => setTimeout(resolve, 50));
    } while (Date.now() < deadline);
    throw new Error("Browser mirror target is missing from the local page");
  }`;
}

/** This app's name in mirror events, so it can skip the echo of its own steps. */
export const MIRROR_ORIGIN = `app-${Math.random().toString(36).slice(2, 12)}`;
export const MIRROR_CAPTURE_MARK = "__paseo_mirror__";

type LocalCaptureListener = (action: BrowserMirrorAction) => void;
const captureListeners = new Map<string, Set<LocalCaptureListener>>();

/** A person's step in a local tab, as reported by the capture script in its page. */
export function publishLocalMirrorCapture(browserId: string, message: string): void {
  if (!message.startsWith(MIRROR_CAPTURE_MARK)) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(message.slice(MIRROR_CAPTURE_MARK.length));
  } catch {
    return;
  }
  const result = BrowserMirrorActionSchema.safeParse(parsed);
  if (!result.success) return;
  const action = result.data;
  for (const listener of captureListeners.get(browserId) ?? []) listener(action);
}

export function subscribeLocalMirrorCapture(
  browserId: string,
  listener: LocalCaptureListener,
): () => void {
  const set = captureListeners.get(browserId) ?? new Set<LocalCaptureListener>();
  set.add(listener);
  captureListeners.set(browserId, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) captureListeners.delete(browserId);
  };
}

/**
 * Injected into every local tab. Reports the person's own clicks, typing, choices, Enter
 * and wheel scrolls as DOM-level steps on the console, which the app reads. Replayed
 * steps are untrusted events, so they are never reported back.
 */
export const MIRROR_CAPTURE_SOURCE = String.raw`(() => {
  if (window.__paseoMirrorCapture) return;
  window.__paseoMirrorCapture = true;
  const log = console.debug.bind(console);
  const send = (action) => { try { log("${MIRROR_CAPTURE_MARK}" + JSON.stringify(action)); } catch (_) {} };
  const esc = (value) => (window.CSS && CSS.escape ? CSS.escape(value) : value);
  const selectorFor = (el) => {
    if (el.id) return "#" + esc(el.id);
    const parts = [];
    let cur = el;
    for (let depth = 0; cur && cur.nodeType === 1 && depth < 12; depth += 1) {
      const tag = cur.tagName.toLowerCase();
      const parent = cur.parentElement;
      if (!parent || tag === "html" || tag === "body") { parts.unshift(tag); break; }
      let nth = 1;
      for (let sib = cur.previousElementSibling; sib; sib = sib.previousElementSibling) {
        if (sib.tagName === cur.tagName) nth += 1;
      }
      parts.unshift(tag + ":nth-of-type(" + nth + ")");
      if (parent.id) { parts.unshift("#" + esc(parent.id)); break; }
      cur = parent;
    }
    return parts.join(" > ");
  };
  const ROLES = { A: "link", BUTTON: "button", SELECT: "combobox", TEXTAREA: "textbox", SUMMARY: "button" };
  const roleOf = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    if (el.tagName !== "INPUT") return ROLES[el.tagName];
    if (["button", "submit", "reset"].indexOf(el.type) >= 0) return "button";
    if (el.type === "checkbox" || el.type === "radio") return el.type;
    return "textbox";
  };
  const nameOf = (el) => {
    const typed = el.tagName === "INPUT" || el.tagName === "TEXTAREA";
    const raw = el.getAttribute("aria-label") || (typed ? el.getAttribute("placeholder") : el.innerText) || "";
    const name = String(raw).trim().slice(0, 120);
    return name || undefined;
  };
  const targetOf = (el) => {
    const target = { selector: selectorFor(el) };
    const role = roleOf(el);
    const name = nameOf(el);
    if (role) target.role = role;
    if (name) target.name = name;
    return target;
  };
  const INTERACTIVE = "a,button,input,textarea,select,summary,label,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[onclick]";
  const isField = (el) => el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
  const pending = new Map();
  const flush = (el) => {
    clearTimeout(pending.get(el));
    pending.delete(el);
    send({ kind: "fill", target: targetOf(el), value: el.isContentEditable ? el.innerText : el.value });
  };
  let enterAt = 0;
  document.addEventListener("click", (event) => {
    if (!event.isTrusted || !(event.target instanceof Element)) return;
    // Enter in a form clicks its submit button by itself; the Enter already covers it.
    if (event.detail === 0 && Date.now() - enterAt < 200) return;
    const el = event.target.closest(INTERACTIVE) || event.target;
    send(Object.assign({ kind: "click", target: targetOf(el) }, event.detail === 2 ? { doubleClick: true } : {}));
  }, true);
  document.addEventListener("input", (event) => {
    const el = event.target;
    if (!event.isTrusted || !isField(el)) return;
    clearTimeout(pending.get(el));
    pending.set(el, setTimeout(() => flush(el), 250));
  }, true);
  document.addEventListener("change", (event) => {
    const el = event.target;
    if (event.isTrusted && el && el.tagName === "SELECT") send({ kind: "select", target: targetOf(el), value: el.value });
  }, true);
  document.addEventListener("keydown", (event) => {
    if (!event.isTrusted || ["Enter", "Escape", "Tab"].indexOf(event.key) < 0) return;
    if (event.key === "Enter") enterAt = Date.now();
    const el = event.target;
    if (pending.has(el)) flush(el);
    const onElement = el instanceof Element && el !== document.body && el !== document.documentElement;
    send(Object.assign({ kind: "keypress", key: event.key }, onElement ? { target: targetOf(el) } : {}));
  }, true);
  let wheelX = 0, wheelY = 0, wheelTimer = null;
  window.addEventListener("wheel", (event) => {
    if (!event.isTrusted) return;
    wheelX += event.deltaX;
    wheelY += event.deltaY;
    if (wheelTimer) return;
    wheelTimer = setTimeout(() => {
      send({ kind: "scroll", deltaX: Math.round(wheelX), deltaY: Math.round(wheelY) });
      wheelX = 0; wheelY = 0; wheelTimer = null;
    }, 120);
  }, { capture: true, passive: true });
})();`;
