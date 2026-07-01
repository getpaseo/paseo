export interface SnapshotPage {
  getURL(): string;
  executeJavaScript(code: string): Promise<unknown>;
}

export interface BrowserSnapshotElement extends RawSnapshotElement {
  ref: string;
}

interface RawSnapshotElement {
  role: string;
  tagName: string;
  text: string;
  selector: string;
  attributes: Record<string, string>;
}

interface BrowserRefState {
  nextRefNumber: number;
  url: string;
  refs: Map<string, RawSnapshotElement>;
}

export type BrowserRefActionResult =
  | { ok: true }
  | { ok: false; reason: "stale_ref" | "missing_ref" };
type BrowserRefFailure = Extract<BrowserRefActionResult, { ok: false }>;

type BrowserRefResolveResult = { ok: true; element: RawSnapshotElement } | BrowserRefFailure;

export class BrowserSnapshotEngine {
  private readonly statesByBrowserId = new Map<string, BrowserRefState>();

  async snapshot(input: {
    browserId: string;
    page: SnapshotPage;
  }): Promise<BrowserSnapshotElement[]> {
    const rawElements = parseRawSnapshotElements(
      await input.page.executeJavaScript(SNAPSHOT_SCRIPT),
    );
    const state = {
      nextRefNumber: 1,
      url: input.page.getURL(),
      refs: new Map<string, RawSnapshotElement>(),
    };
    const elements = rawElements.map((element) => {
      const ref = `@e${state.nextRefNumber++}`;
      state.refs.set(ref, element);
      return {
        ref,
        role: element.role,
        tagName: element.tagName,
        text: element.text,
        selector: element.selector,
        attributes: element.attributes,
      };
    });
    this.statesByBrowserId.set(input.browserId, state);
    return elements;
  }

  async click(input: {
    browserId: string;
    page: SnapshotPage;
    ref: string;
  }): Promise<BrowserRefActionResult> {
    return this.runRefScript(input, (selector) => buildClickScript(selector));
  }

  async fill(input: {
    browserId: string;
    page: SnapshotPage;
    ref: string;
    value: string;
  }): Promise<BrowserRefActionResult> {
    return this.runRefScript(input, (selector) => buildFillScript(selector, input.value));
  }

  async typeText(input: {
    browserId: string;
    page: SnapshotPage;
    ref?: string;
    text: string;
  }): Promise<BrowserRefActionResult> {
    const selector = this.resolveOptionalRef(input);
    if (!selector.ok) {
      return selector;
    }
    const result = await input.page.executeJavaScript(
      buildTypeScript(selector.selector, input.text),
    );
    return input.ref && result === false ? { ok: false, reason: "stale_ref" } : { ok: true };
  }

  async keypress(input: {
    browserId: string;
    page: SnapshotPage;
    ref?: string;
    key: string;
  }): Promise<BrowserRefActionResult> {
    const selector = this.resolveOptionalRef(input);
    if (!selector.ok) {
      return selector;
    }
    const result = await input.page.executeJavaScript(
      buildKeypressScript(selector.selector, input.key),
    );
    return input.ref && result === false ? { ok: false, reason: "stale_ref" } : { ok: true };
  }

  async focus(input: {
    browserId: string;
    page: SnapshotPage;
    ref: string;
  }): Promise<BrowserRefActionResult> {
    return this.runRefScript(input, (selector) => buildFocusScript(selector));
  }

  async clear(input: {
    browserId: string;
    page: SnapshotPage;
    ref: string;
  }): Promise<BrowserRefActionResult> {
    return this.runRefScript(input, (selector) => buildClearScript(selector));
  }

  async check(input: {
    browserId: string;
    page: SnapshotPage;
    ref: string;
    checked: boolean;
  }): Promise<BrowserRefActionResult> {
    return this.runRefScript(input, (selector) => buildCheckScript(selector, input.checked));
  }

  async select(input: {
    browserId: string;
    page: SnapshotPage;
    ref: string;
    value: string;
  }): Promise<BrowserRefActionResult> {
    return this.runRefScript(input, (selector) => buildSelectScript(selector, input.value));
  }

  async hover(input: {
    browserId: string;
    page: SnapshotPage;
    ref: string;
  }): Promise<BrowserRefActionResult> {
    return this.runRefScript(input, (selector) => buildHoverScript(selector));
  }

  async drag(input: {
    browserId: string;
    page: SnapshotPage;
    sourceRef: string;
    targetRef: string;
  }): Promise<BrowserRefActionResult> {
    const source = this.resolveRef({
      browserId: input.browserId,
      page: input.page,
      ref: input.sourceRef,
    });
    if (!source.ok) {
      return source;
    }
    const target = this.resolveRef({
      browserId: input.browserId,
      page: input.page,
      ref: input.targetRef,
    });
    if (!target.ok) {
      return target;
    }
    const result = await input.page.executeJavaScript(
      buildDragScript(source.element.selector, target.element.selector),
    );
    return result === false ? { ok: false, reason: "stale_ref" } : { ok: true };
  }

  clearBrowser(browserId: string): void {
    this.statesByBrowserId.delete(browserId);
  }

  selectorForRef(input: {
    browserId: string;
    page: SnapshotPage;
    ref: string;
  }): { ok: true; selector: string } | BrowserRefFailure {
    const resolved = this.resolveRef(input);
    if (!resolved.ok) {
      return resolved;
    }
    return { ok: true, selector: resolved.element.selector };
  }

  private async runRefScript(
    input: { browserId: string; page: SnapshotPage; ref: string },
    buildScript: (selector: string) => string,
  ): Promise<BrowserRefActionResult> {
    const resolved = this.resolveRef(input);
    if (!resolved.ok) {
      return resolved;
    }
    const result = await input.page.executeJavaScript(buildScript(resolved.element.selector));
    return result === false ? { ok: false, reason: "stale_ref" } : { ok: true };
  }

  private resolveRef(input: {
    browserId: string;
    page: SnapshotPage;
    ref: string;
  }): BrowserRefResolveResult {
    const state = this.statesByBrowserId.get(input.browserId);
    if (!state || state.url !== input.page.getURL()) {
      return { ok: false, reason: "stale_ref" };
    }
    const element = state.refs.get(input.ref);
    if (!element) {
      return { ok: false, reason: "missing_ref" };
    }
    return { ok: true, element };
  }

  private resolveOptionalRef(input: {
    browserId: string;
    page: SnapshotPage;
    ref?: string;
  }): { ok: true; selector: string | undefined } | BrowserRefFailure {
    if (!input.ref) {
      return { ok: true, selector: undefined };
    }
    const resolved = this.resolveRef({
      browserId: input.browserId,
      page: input.page,
      ref: input.ref,
    });
    if (!resolved.ok) {
      return resolved;
    }
    return { ok: true, selector: resolved.element.selector };
  }
}

function buildClickScript(selector: string): string {
  return String.raw`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    element.click();
    return true;
  })()`;
}

function buildFillScript(selector: string, value: string): string {
  return String.raw`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    element.focus();
    const nextValue = ${JSON.stringify(value)};
    if ('value' in element) {
      element.value = nextValue;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    element.textContent = nextValue;
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: nextValue }));
    return true;
  })()`;
}

function buildTypeScript(selector: string | undefined, text: string): string {
  return String.raw`(() => {
    const element = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : "document.activeElement"};
    if (!element) return false;
    element.scrollIntoView?.({ block: 'center', inline: 'center' });
    element.focus?.();
    const text = ${JSON.stringify(text)};
    if ('value' in element) {
      element.value = String(element.value || '') + text;
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    element.textContent = String(element.textContent || '') + text;
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    return true;
  })()`;
}

function buildKeypressScript(selector: string | undefined, key: string): string {
  return String.raw`(() => {
    const element = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : "document.activeElement"};
    if (!element) return false;
    element.focus?.();
    const key = ${JSON.stringify(key)};
    const eventInit = { bubbles: true, cancelable: true, key };
    element.dispatchEvent(new KeyboardEvent('keydown', eventInit));
    element.dispatchEvent(new KeyboardEvent('keypress', eventInit));
    element.dispatchEvent(new KeyboardEvent('keyup', eventInit));
    return true;
  })()`;
}

function buildFocusScript(selector: string): string {
  return String.raw`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    element.scrollIntoView?.({ block: 'center', inline: 'center' });
    element.focus?.();
    return document.activeElement === element;
  })()`;
}

function buildClearScript(selector: string): string {
  return String.raw`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    element.scrollIntoView?.({ block: 'center', inline: 'center' });
    element.focus?.();
    if ('value' in element) {
      element.value = '';
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContent' }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    element.textContent = '';
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContent' }));
    return true;
  })()`;
}

function buildCheckScript(selector: string, checked: boolean): string {
  return String.raw`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    element.scrollIntoView?.({ block: 'center', inline: 'center' });
    element.focus?.();
    const nextChecked = ${JSON.stringify(checked)};
    if ('checked' in element) {
      element.checked = nextChecked;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    if (element.getAttribute('role') === 'checkbox' || element.getAttribute('role') === 'radio') {
      element.setAttribute('aria-checked', String(nextChecked));
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    return false;
  })()`;
}

function buildSelectScript(selector: string, value: string): string {
  return String.raw`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    element.scrollIntoView?.({ block: 'center', inline: 'center' });
    element.focus?.();
    const nextValue = ${JSON.stringify(value)};
    if ('value' in element) {
      element.value = nextValue;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    return false;
  })()`;
}

function buildHoverScript(selector: string): string {
  return String.raw`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    element.scrollIntoView?.({ block: 'center', inline: 'center' });
    const rect = element.getBoundingClientRect();
    const eventInit = {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      screenX: window.screenX + rect.left + rect.width / 2,
      screenY: window.screenY + rect.top + rect.height / 2,
      view: window,
    };
    element.dispatchEvent(new MouseEvent('mouseover', eventInit));
    element.dispatchEvent(new MouseEvent('mouseenter', eventInit));
    element.dispatchEvent(new MouseEvent('mousemove', eventInit));
    return true;
  })()`;
}

function buildDragScript(sourceSelector: string, targetSelector: string): string {
  return String.raw`(() => {
    const source = document.querySelector(${JSON.stringify(sourceSelector)});
    const target = document.querySelector(${JSON.stringify(targetSelector)});
    if (!source || !target) return false;
    source.scrollIntoView?.({ block: 'center', inline: 'center' });
    target.scrollIntoView?.({ block: 'center', inline: 'center' });
    const data = new DataTransfer();
    const sourceRect = source.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    function eventInit(rect) {
      return {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        screenX: window.screenX + rect.left + rect.width / 2,
        screenY: window.screenY + rect.top + rect.height / 2,
        dataTransfer: data,
        view: window,
      };
    }
    source.dispatchEvent(new MouseEvent('mousedown', eventInit(sourceRect)));
    source.dispatchEvent(new DragEvent('dragstart', eventInit(sourceRect)));
    target.dispatchEvent(new DragEvent('dragenter', eventInit(targetRect)));
    target.dispatchEvent(new DragEvent('dragover', eventInit(targetRect)));
    target.dispatchEvent(new DragEvent('drop', eventInit(targetRect)));
    source.dispatchEvent(new DragEvent('dragend', eventInit(sourceRect)));
    target.dispatchEvent(new MouseEvent('mouseup', eventInit(targetRect)));
    return true;
  })()`;
}

function parseRawSnapshotElements(value: unknown): RawSnapshotElement[] {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.flatMap((item): RawSnapshotElement[] => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const record = item as Record<string, unknown>;
    const selector = readString(record.selector);
    if (!selector) {
      return [];
    }
    return [
      {
        role: readString(record.role) || "generic",
        tagName: (readString(record.tagName) || "element").toLowerCase(),
        text: readString(record.text) || "",
        selector,
        attributes: readAttributes(record.attributes),
      },
    ];
  });
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readAttributes(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, attributeValue] of Object.entries(value)) {
    if (typeof attributeValue === "string") {
      result[key] = attributeValue;
    }
  }
  return result;
}

const SNAPSHOT_SCRIPT = String.raw`(() => {
  const MAX_ELEMENTS = 200;
  const CANDIDATE_SELECTOR = [
    'a[href]',
    'button',
    'input',
    'textarea',
    'select',
    'summary',
    '[role]',
    '[tabindex]:not([tabindex="-1"])',
    '[contenteditable=""]',
    '[contenteditable="true"]'
  ].join(',');

  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') {
      return window.CSS.escape(value);
    }
    return String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
  }

  function isVisible(element) {
    const style = window.getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function roleFor(element) {
    const explicit = element.getAttribute('role');
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    if (tag === 'a') return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'summary') return 'button';
    if (tag === 'input') {
      const type = (element.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
      return 'textbox';
    }
    return 'generic';
  }

  function textFor(element) {
    const tag = element.tagName.toLowerCase();
    const pieces = [
      element.getAttribute('aria-label'),
      element.getAttribute('alt'),
      element.getAttribute('title'),
      tag === 'input' ? element.getAttribute('placeholder') : null,
      tag === 'input' || tag === 'textarea' ? element.value : null,
      element.innerText,
      element.textContent
    ];
    const text = pieces.find((piece) => typeof piece === 'string' && piece.trim().length > 0);
    return (text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  }

  function selectorFor(element) {
    if (element.id) return '#' + cssEscape(element.id);
    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
      const tag = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (!parent) break;
      const siblings = Array.from(parent.children).filter((sibling) => sibling.tagName === current.tagName);
      const index = siblings.indexOf(current) + 1;
      parts.unshift(siblings.length > 1 ? tag + ':nth-of-type(' + index + ')' : tag);
      current = parent;
    }
    return parts.length > 0 ? parts.join(' > ') : element.tagName.toLowerCase();
  }

  return JSON.stringify(Array.from(document.querySelectorAll(CANDIDATE_SELECTOR))
    .filter(isVisible)
    .slice(0, MAX_ELEMENTS)
    .map((element) => ({
      role: roleFor(element),
      tagName: element.tagName.toLowerCase(),
      text: textFor(element),
      selector: selectorFor(element),
      attributes: {
        ...(element.id ? { id: element.id } : {}),
        ...(element.getAttribute('name') ? { name: element.getAttribute('name') } : {}),
        ...(element.getAttribute('type') ? { type: element.getAttribute('type') } : {}),
        ...(element.getAttribute('href') ? { href: element.getAttribute('href') } : {}),
        ...(element.getAttribute('aria-label') ? { 'aria-label': element.getAttribute('aria-label') } : {})
      }
    })));
})()`;
