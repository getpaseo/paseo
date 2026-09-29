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

// Password manager. Electron ships no Chromium save/autofill UI, so the guest reports trusted
// login submissions and fills saved logins on a trusted focus. Main derives the origin from the
// sender frame and never trusts the page for it. Top frame of http(s) pages only.

const CREDENTIALS_SUBMITTED_CHANNEL = "paseo:browser:credentials-submitted";
const CREDENTIALS_LOOKUP_CHANNEL = "paseo:browser:credentials-lookup";
const LOGIN_SCOPE_MAX_DEPTH = 5;
const DUPLICATE_SUBMIT_WINDOW_MS = 1000;
const USERNAME_INPUT_TYPES = new Set(["text", "email", "tel", ""]);
const USERNAME_HINT = /user|email|login/i;

interface GuestCredentials {
  username: string;
  password: string;
}

let lastSubmitted: { key: string; at: number } | null = null;
const lookedUpScopes = new WeakSet<Element>();

function isVisibleInput(input: HTMLInputElement): boolean {
  return (
    !input.disabled &&
    input.getClientRects().length > 0 &&
    getComputedStyle(input).visibility !== "hidden"
  );
}

function isPasswordInput(element: EventTarget | null): element is HTMLInputElement {
  return element instanceof HTMLInputElement && element.type === "password";
}

function visiblePasswordInputs(scope: ParentNode): HTMLInputElement[] {
  return Array.from(scope.querySelectorAll<HTMLInputElement>("input[type=password]")).filter(
    isVisibleInput,
  );
}

// The form when there is one; otherwise the nearest ancestor that contains a visible password
// field, which covers SPA logins built from loose inputs and type=button controls.
function findLoginScope(element: Element): Element | null {
  const form = element instanceof HTMLInputElement ? element.form : element.closest("form");
  if (form) {
    return visiblePasswordInputs(form).length > 0 ? form : null;
  }
  let candidate: Element | null = element;
  for (let depth = 0; candidate && depth <= LOGIN_SCOPE_MAX_DEPTH; depth += 1) {
    if (visiblePasswordInputs(candidate).length > 0) {
      return candidate;
    }
    candidate = candidate.parentElement;
  }
  return null;
}

function precedes(a: Element, b: Element): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

function findUsernameInput(
  scope: ParentNode,
  password: HTMLInputElement,
  options: { requireValue: boolean },
): HTMLInputElement | null {
  const candidates = Array.from(scope.querySelectorAll<HTMLInputElement>("input")).filter(
    (input) =>
      USERNAME_INPUT_TYPES.has(input.getAttribute("type")?.toLowerCase() ?? "") &&
      precedes(input, password) &&
      isVisibleInput(input) &&
      (!options.requireValue || input.value.trim().length > 0),
  );
  const hinted = candidates.find(
    (input) =>
      input.autocomplete.split(/\s+/).includes("username") ||
      USERNAME_HINT.test(`${input.name} ${input.id}`),
  );
  return hinted ?? candidates.at(-1) ?? null;
}

function readCredentials(scope: Element): GuestCredentials | null {
  const password = visiblePasswordInputs(scope).find((input) => input.value.length > 0);
  if (!password) {
    return null;
  }
  const username = findUsernameInput(scope, password, { requireValue: true });
  return { username: username?.value.trim() ?? "", password: password.value };
}

// isTrusted alone is not a gesture: script-called focus() and button.click() dispatch trusted
// focus and submit events. Transient user activation only exists after real input.
function hasUserGesture(event: Event): boolean {
  return event.isTrusted && navigator.userActivation.isActive;
}

function reportCredentials(scope: Element | null): void {
  const credentials = scope ? readCredentials(scope) : null;
  if (!credentials) {
    return;
  }
  // A click, Enter and the resulting submit event all describe one login.
  const key = `${credentials.username}\n${credentials.password}`;
  const now = Date.now();
  if (lastSubmitted?.key === key && now - lastSubmitted.at < DUPLICATE_SUBMIT_WINDOW_MS) {
    return;
  }
  lastSubmitted = { key, at: now };
  ipcRenderer.send(CREDENTIALS_SUBMITTED_CHANNEL, credentials);
}

function handleLoginSubmit(event: SubmitEvent): void {
  if (hasUserGesture(event) && event.target instanceof HTMLFormElement) {
    reportCredentials(findLoginScope(event.target));
  }
}

function handleLoginClick(event: MouseEvent): void {
  if (!hasUserGesture(event) || !(event.target instanceof Element)) {
    return;
  }
  const button = event.target.closest("button, input[type=submit]");
  // Inside a form only submit buttons log in; "show password" toggles are type=button.
  const isFormNonSubmit =
    button instanceof HTMLButtonElement && button.form !== null && button.type !== "submit";
  if (button && !isFormNonSubmit) {
    reportCredentials(findLoginScope(button));
  }
}

function handleLoginEnter(event: KeyboardEvent): void {
  if (hasUserGesture(event) && event.key === "Enter" && isPasswordInput(event.target)) {
    reportCredentials(findLoginScope(event.target));
  }
}

function isGuestCredentials(value: unknown): value is GuestCredentials {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.username === "string" && typeof record.password === "string";
}

function setInputValue(input: HTMLInputElement, value: string): void {
  // The prototype setter bypasses page-side value trackers (React), so the page sees a real edit.
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

async function fillLogin(scope: Element): Promise<void> {
  const credentials: unknown = await ipcRenderer.invoke(CREDENTIALS_LOOKUP_CHANNEL);
  const newest: unknown = Array.isArray(credentials) ? credentials[0] : null;
  const password = visiblePasswordInputs(scope)[0];
  if (!isGuestCredentials(newest) || !password) {
    return;
  }
  const username = findUsernameInput(scope, password, { requireValue: false });
  if (username && username.value.length === 0 && newest.username.length > 0) {
    setInputValue(username, newest.username);
  }
  if (password.value.length === 0) {
    setInputValue(password, newest.password);
  }
}

function handleLoginFocus(event: Event): void {
  if (!hasUserGesture(event) || !(event.target instanceof HTMLInputElement)) {
    return;
  }
  const scope = findLoginScope(event.target);
  if (!scope || lookedUpScopes.has(scope)) {
    return;
  }
  const password = visiblePasswordInputs(scope)[0];
  const isLoginField =
    event.target === password ||
    (password !== undefined &&
      findUsernameInput(scope, password, { requireValue: false }) === event.target);
  if (!isLoginField) {
    return;
  }
  lookedUpScopes.add(scope);
  void fillLogin(scope);
}

if (window === window.top && (location.protocol === "http:" || location.protocol === "https:")) {
  window.addEventListener("submit", handleLoginSubmit, { capture: true });
  window.addEventListener("click", handleLoginClick, { capture: true });
  window.addEventListener("keydown", handleLoginEnter, { capture: true });
  window.addEventListener("focusin", handleLoginFocus, { capture: true });
  window.addEventListener("pointerdown", handleLoginFocus, { capture: true });
}
