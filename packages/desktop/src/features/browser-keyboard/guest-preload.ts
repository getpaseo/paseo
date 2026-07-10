import { ipcRenderer } from "electron";
import type { BrowserKeyboardPolicy, BrowserShortcutPrefix } from "./policy.js";

const POLICY_CHANNEL = "paseo:browser-keyboard-policy";
const SHORTCUT_INPUT_CHANNEL = "paseo:browser-shortcut-input";

let browserId: string | null = null;
let policy: BrowserShortcutPrefix[] = [];

interface BrowserKeyboardPolicyPayload extends BrowserKeyboardPolicy {
  browserId: string;
}

function matchesPolicy(event: KeyboardEvent): boolean {
  return policy.some((prefix) => {
    if (
      prefix.alt !== event.altKey ||
      prefix.control !== event.ctrlKey ||
      prefix.meta !== event.metaKey ||
      prefix.shift !== event.shiftKey ||
      (prefix.repeat === false && event.repeat)
    ) {
      return false;
    }
    if (prefix.key === undefined) {
      return prefix.code === event.code;
    }
    const eventKey = event.key.toLowerCase();
    if (eventKey === prefix.key) {
      return true;
    }
    if (prefix.shift && prefix.shiftedKey !== undefined && eventKey === prefix.shiftedKey) {
      return true;
    }
    return (prefix.alt || prefix.codeFallback === true) && prefix.code === event.code;
  });
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }
  if (
    target.closest("[contenteditable=true], [contenteditable=''], [contenteditable=plaintext-only]")
  ) {
    return true;
  }
  return target.matches("input, textarea, select, [role=textbox]");
}

ipcRenderer.on(POLICY_CHANNEL, (_event, value: BrowserKeyboardPolicyPayload) => {
  browserId = value.browserId;
  policy = value.prefixes;
});

window.addEventListener("keydown", (event) => {
  if (
    !event.isTrusted ||
    event.defaultPrevented ||
    !browserId ||
    isEditableTarget(event.target) ||
    !matchesPolicy(event)
  ) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  ipcRenderer.send(SHORTCUT_INPUT_CHANNEL, {
    alt: event.altKey,
    browserId,
    code: event.code,
    control: event.ctrlKey,
    key: event.key,
    meta: event.metaKey,
    repeat: event.repeat,
    shift: event.shiftKey,
  });
});
