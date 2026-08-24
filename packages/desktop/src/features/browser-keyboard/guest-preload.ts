import { ipcRenderer } from "electron";
import type { BrowserKeyboardPolicy, BrowserShortcutPrefix } from "./policy.js";

const POLICY_CHANNEL = "paseo:browser-keyboard-policy";
const POLICY_REQUEST_CHANNEL = "paseo:browser-keyboard-policy-request";
const SHORTCUT_INPUT_CHANNEL = "paseo:browser-shortcut-input";

let browserId: string | null = null;
let policy: BrowserShortcutPrefix[] = [];

interface BrowserKeyboardPolicyPayload extends BrowserKeyboardPolicy {
  browserId: string;
}

function matchesPolicy(event: KeyboardEvent): boolean {
  const editable = isEditableTarget(event.target);
  return policy.some((prefix) => {
    if (
      prefix.alt !== event.altKey ||
      prefix.control !== event.ctrlKey ||
      prefix.meta !== event.metaKey ||
      prefix.shift !== event.shiftKey ||
      (prefix.editable === false && editable) ||
      (prefix.repeat === false && event.repeat)
    ) {
      return false;
    }
    if (prefix.key === undefined) {
      return matchesCode(prefix.code, event.code);
    }
    const eventKey = event.key.toLowerCase();
    if (eventKey === prefix.key) {
      return true;
    }
    if (prefix.shift && prefix.shiftedKey !== undefined && eventKey === prefix.shiftedKey) {
      return true;
    }
    return (prefix.alt || prefix.codeFallback === true) && matchesCode(prefix.code, event.code);
  });
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  const element = target as HTMLElement;
  if (element.isContentEditable) {
    return true;
  }
  const tag = element.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select";
}

function matchesCode(prefixCode: string, eventCode: string): boolean {
  if (prefixCode !== "Digit") {
    return prefixCode === eventCode;
  }
  return /^(?:Digit|Numpad)[1-9]$/.test(eventCode);
}

function stageShortcutForward(event: KeyboardEvent): void {
  if (!event.isTrusted || event.defaultPrevented || !browserId || !matchesPolicy(event)) {
    return;
  }

  const shortcutBrowserId = browserId;
  window.addEventListener(
    "keydown",
    (completedEvent) => {
      if (completedEvent !== event || completedEvent.defaultPrevented) {
        return;
      }
      completedEvent.preventDefault();
      ipcRenderer.send(SHORTCUT_INPUT_CHANNEL, {
        alt: completedEvent.altKey,
        browserId: shortcutBrowserId,
        code: completedEvent.code,
        control: completedEvent.ctrlKey,
        key: completedEvent.key,
        meta: completedEvent.metaKey,
        repeat: completedEvent.repeat,
        shift: completedEvent.shiftKey,
      });
    },
    { once: true },
  );
}

window.addEventListener("keydown", stageShortcutForward, { capture: true });

ipcRenderer.on(POLICY_CHANNEL, (_event, value: BrowserKeyboardPolicyPayload) => {
  if (!value || typeof value.browserId !== "string" || !Array.isArray(value.prefixes)) {
    return;
  }
  browserId = value.browserId;
  policy = value.prefixes;
});

ipcRenderer.send(POLICY_REQUEST_CHANNEL);

const ELEMENT_BEGIN_CHANNEL = "paseo:browser-element:guest-begin";
const ELEMENT_CANCEL_CHANNEL = "paseo:browser-element:guest-cancel";
const ELEMENT_READY_CHANNEL = "paseo:browser-element:guest-ready";
const ELEMENT_RESULT_CHANNEL = "paseo:browser-element:guest-result";

interface ElementSelectorInput {
  browserId: string;
  token: string;
  mode: "annotate" | "screenshot";
}

interface ElementSelectorSession {
  token: string;
  destroy(): void;
}

let elementSelector: ElementSelectorSession | null = null;

function selectorPath(element: Element): string {
  if (element.id) return `#${CSS.escape(element.id)}`;
  const path: string[] = [];
  let cursor: Element | null = element;
  while (cursor) {
    let segment = cursor.tagName.toLowerCase();
    const siblings = cursor.parentElement
      ? Array.from(cursor.parentElement.children).filter(
          (candidate) => candidate.tagName === cursor?.tagName,
        )
      : [];
    if (siblings.length > 1) segment += `:nth-of-type(${siblings.indexOf(cursor) + 1})`;
    path.unshift(segment);
    cursor = cursor.parentElement;
  }
  return path.join(" > ");
}

function reactComponentName(element: Element): string | null {
  const record = element as Element & Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!key.startsWith("__reactFiber$") && !key.startsWith("__reactInternalInstance$")) continue;
    let fiber = record[key] as Record<string, unknown> | null;
    while (fiber) {
      const type = fiber.type;
      if (typeof type === "function") {
        return (type as Function & { displayName?: string }).displayName ?? type.name ?? null;
      }
      fiber = (fiber._debugOwner ?? fiber.return ?? null) as Record<string, unknown> | null;
    }
  }
  return null;
}

function conciseDescription(element: Element): string {
  const id = element.id ? `#${element.id}` : "";
  const classes = Array.from(element.classList)
    .filter((name) => !name.startsWith("__paseo"))
    .slice(0, 2)
    .map((name) => `.${name}`)
    .join("");
  return `${element.tagName.toLowerCase()}${id}${classes}`;
}

function relevantStyles(element: Element): Record<string, string> {
  const computed = getComputedStyle(element);
  const names = [
    "display",
    "position",
    "width",
    "height",
    "color",
    "background-color",
    "font-size",
    "font-family",
    "padding",
    "margin",
    "border",
    "flex",
    "grid-template-columns",
    "gap",
    "overflow",
    "opacity",
    "z-index",
  ];
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = computed.getPropertyValue(name);
      return value && !["none", "normal", "auto", "0px", "rgba(0, 0, 0, 0)"].includes(value)
        ? [[name, value]]
        : [];
    }),
  );
}

function elementSelection(element: HTMLElement): Record<string, unknown> {
  const rect = element.getBoundingClientRect();
  const componentName = reactComponentName(element);
  const parents: string[] = [];
  let parent = element.parentElement;
  while (parent && parents.length < 5) {
    parents.push(conciseDescription(parent));
    parent = parent.parentElement;
  }
  const children = Array.from(element.children).slice(0, 8).map(conciseDescription);
  if (element.children.length > 8) children.push(`...(${element.children.length} total)`);
  return {
    tag: element.tagName.toLowerCase(),
    text: (element.innerText || "").slice(0, 500),
    selector: selectorPath(element),
    attributes: Object.fromEntries(
      Array.from(element.attributes, ({ name, value }) => [name, value]),
    ),
    url: location.href,
    outerHTML: element.outerHTML.slice(0, 2_000),
    computedStyles: relevantStyles(element),
    boundingRect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
    reactSource: componentName
      ? { fileName: null, lineNumber: null, columnNumber: null, componentName }
      : null,
    parentChain: parents,
    children,
  };
}

function installElementSelector(input: ElementSelectorInput): void {
  elementSelector?.destroy();
  if (document.readyState === "loading" || !document.head || !document.documentElement) {
    ipcRenderer.send(ELEMENT_RESULT_CHANNEL, {
      token: input.token,
      status: "failed",
      reason: "loading",
    });
    return;
  }
  const style = document.createElement("style");
  style.textContent = `
    .__paseo-select-hover { outline: 2px solid #3b82f6 !important; outline-offset: 2px !important; }
    .__paseo-select-label { position: fixed; z-index: 2147483647; pointer-events: none; padding: 5px 8px; border-radius: 6px; background: rgba(24,24,27,.96); color: #fff; font: 500 11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; box-shadow: 0 3px 12px rgba(0,0,0,.35); }
    .__paseo-selecting, .__paseo-selecting * { cursor: crosshair !important; user-select: none !important; }
  `;
  document.head.appendChild(style);
  document.documentElement.classList.add("__paseo-selecting");
  const label = document.createElement("div");
  label.className = "__paseo-select-label";
  label.hidden = true;
  document.documentElement.appendChild(label);
  let hovered: HTMLElement | null = null;

  function block(event: Event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }
  function destroy() {
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKey, true);
    for (const eventName of ["mousedown", "mouseup", "pointerdown", "pointerup", "touchstart"])
      document.removeEventListener(eventName, block, true);
    document.documentElement.classList.remove("__paseo-selecting");
    hovered?.classList.remove("__paseo-select-hover");
    label.remove();
    style.remove();
    if (elementSelector?.token === input.token) elementSelector = null;
  }
  function finish(payload: Record<string, unknown>) {
    destroy();
    ipcRenderer.send(ELEMENT_RESULT_CHANNEL, { token: input.token, ...payload });
  }
  function onMove(event: MouseEvent) {
    block(event);
    hovered?.classList.remove("__paseo-select-hover");
    hovered = event.target instanceof HTMLElement ? event.target : null;
    if (!hovered || hovered === label) return;
    hovered.classList.add("__paseo-select-hover");
    const rect = hovered.getBoundingClientRect();
    const component = reactComponentName(hovered);
    label.textContent = `${conciseDescription(hovered)}  ${Math.round(rect.width)}×${Math.round(rect.height)}${component ? `  <${component}>` : ""}`;
    label.hidden = false;
    label.style.left = `${Math.max(4, Math.min(rect.left, innerWidth - label.offsetWidth - 4))}px`;
    label.style.top = `${Math.max(4, rect.top - label.offsetHeight - 6)}px`;
  }
  function onClick(event: MouseEvent) {
    block(event);
    const element = event.target instanceof HTMLElement ? event.target : null;
    if (element && element !== label)
      finish({ status: "selected", selection: elementSelection(element) });
  }
  function onKey(event: KeyboardEvent) {
    if (event.key === "Escape") finish({ status: "cancelled" });
  }

  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKey, true);
  for (const eventName of ["mousedown", "mouseup", "pointerdown", "pointerup", "touchstart"])
    document.addEventListener(eventName, block, true);
  elementSelector = { token: input.token, destroy };
}

ipcRenderer.on(ELEMENT_BEGIN_CHANNEL, (_event, input: ElementSelectorInput) => {
  if (input && typeof input.token === "string") installElementSelector(input);
});
ipcRenderer.on(ELEMENT_CANCEL_CHANNEL, (_event, token: unknown) => {
  if (typeof token === "string" && elementSelector?.token === token) elementSelector.destroy();
});
ipcRenderer.send(ELEMENT_READY_CHANNEL);
