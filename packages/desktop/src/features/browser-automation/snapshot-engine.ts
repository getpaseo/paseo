import { ARIA_SNAPSHOT_SCRIPT, ARIA_SNAPSHOT_SCRIPT_MARKER } from "./aria-snapshot-script.js";

export interface SnapshotPage {
  getURL(): string;
  executeJavaScript(code: string): Promise<unknown>;
}

export interface BrowserAriaSnapshot {
  format: "aria-yaml";
  snapshot: string;
  truncated: boolean;
  stats: BrowserAriaSnapshotStats;
}

export interface BrowserAriaSnapshotStats {
  nodeCount: number;
  refCount: number;
  textLength: number;
  iframeCount?: number;
  maxDepth?: number;
}

interface SnapshotNode {
  kind: "role" | "text" | "group";
  role?: string;
  name?: string;
  text?: string;
  tagName?: string;
  attributes?: string[];
  ref?: string;
  fingerprint?: BrowserRefFingerprint;
  children?: SnapshotNode[];
}

interface BrowserRefFingerprint {
  role: string;
  name: string;
  tagName: string;
  type: string;
  ariaLabel: string;
}

interface RawAriaSnapshot {
  marker: string;
  root: SnapshotNode;
  refs: BrowserRefMetadata[];
  truncated: boolean;
  stats: BrowserAriaSnapshotStats;
}

interface BrowserRefMetadata {
  ref: string;
  fingerprint: BrowserRefFingerprint;
}

interface BrowserRefState {
  refs: Map<string, BrowserRefMetadata>;
}

export type BrowserRefActionResult =
  | { ok: true }
  | { ok: false; reason: "stale_ref" | "missing_ref" };
type BrowserRefFailure = Extract<BrowserRefActionResult, { ok: false }>;

type BrowserRefResolveResult = { ok: true; metadata: BrowserRefMetadata } | BrowserRefFailure;

const TRUNCATION_MARKER = '- text: "Snapshot truncated."';
const MAX_RENDERED_TEXT_LENGTH = 80_000;

export class BrowserSnapshotEngine {
  private readonly statesByBrowserId = new Map<string, BrowserRefState>();

  async snapshot(input: { browserId: string; page: SnapshotPage }): Promise<BrowserAriaSnapshot> {
    const rawSnapshot = parseAriaSnapshot(await input.page.executeJavaScript(ARIA_SNAPSHOT_SCRIPT));
    const rendered = renderSnapshot(rawSnapshot.root);
    const capped = capRenderedSnapshot(rendered, rawSnapshot.truncated);
    this.statesByBrowserId.set(input.browserId, {
      refs: new Map(rawSnapshot.refs.map((ref) => [ref.ref, ref])),
    });
    return {
      format: "aria-yaml",
      snapshot: capped.snapshot,
      truncated: capped.truncated,
      stats: {
        ...rawSnapshot.stats,
        refCount: rawSnapshot.refs.length,
        textLength: capped.snapshot.length,
      },
    };
  }

  async click(input: {
    browserId: string;
    page: SnapshotPage;
    ref: string;
  }): Promise<BrowserRefActionResult> {
    return this.runRefScript(input, (ref) => buildClickScript(ref));
  }

  async fill(input: {
    browserId: string;
    page: SnapshotPage;
    ref: string;
    value: string;
  }): Promise<BrowserRefActionResult> {
    return this.runRefScript(input, (ref) => buildFillScript(ref, input.value));
  }

  async typeText(input: {
    browserId: string;
    page: SnapshotPage;
    ref?: string;
    text: string;
  }): Promise<BrowserRefActionResult> {
    const resolved = this.resolveOptionalRef(input);
    if (!resolved.ok) {
      return resolved;
    }
    const result = await input.page.executeJavaScript(
      buildTypeScript(resolved.metadata, input.text),
    );
    return readActionResult(result, Boolean(input.ref));
  }

  async keypress(input: {
    browserId: string;
    page: SnapshotPage;
    ref?: string;
    key: string;
  }): Promise<BrowserRefActionResult> {
    const resolved = this.resolveOptionalRef(input);
    if (!resolved.ok) {
      return resolved;
    }
    const result = await input.page.executeJavaScript(
      buildKeypressScript(resolved.metadata, input.key),
    );
    return readActionResult(result, Boolean(input.ref));
  }

  async select(input: {
    browserId: string;
    page: SnapshotPage;
    ref: string;
    value: string;
  }): Promise<BrowserRefActionResult> {
    return this.runRefScript(input, (ref) => buildSelectScript(ref, input.value));
  }

  async hover(input: {
    browserId: string;
    page: SnapshotPage;
    ref: string;
  }): Promise<BrowserRefActionResult> {
    return this.runRefScript(input, (ref) => buildHoverScript(ref));
  }

  async drag(input: {
    browserId: string;
    page: SnapshotPage;
    sourceRef: string;
    targetRef: string;
  }): Promise<BrowserRefActionResult> {
    const source = this.resolveRef({
      browserId: input.browserId,
      ref: input.sourceRef,
    });
    if (!source.ok) {
      return source;
    }
    const target = this.resolveRef({
      browserId: input.browserId,
      ref: input.targetRef,
    });
    if (!target.ok) {
      return target;
    }
    const result = await input.page.executeJavaScript(
      buildDragScript(source.metadata, target.metadata),
    );
    return readActionResult(result, true);
  }

  clearBrowser(browserId: string): void {
    this.statesByBrowserId.delete(browserId);
  }

  runtimeElementExpression(input: { browserId: string; ref: string }): string | BrowserRefFailure {
    const resolved = this.resolveRef(input);
    if (!resolved.ok) {
      return resolved;
    }
    return buildRuntimeElementExpression(resolved.metadata);
  }

  private async runRefScript(
    input: { browserId: string; page: SnapshotPage; ref: string },
    buildScript: (ref: BrowserRefMetadata) => string,
  ): Promise<BrowserRefActionResult> {
    const resolved = this.resolveRef(input);
    if (!resolved.ok) {
      return resolved;
    }
    const result = await input.page.executeJavaScript(buildScript(resolved.metadata));
    return readActionResult(result, true);
  }

  private resolveRef(input: { browserId: string; ref: string }): BrowserRefResolveResult {
    const state = this.statesByBrowserId.get(input.browserId);
    if (!state) {
      return { ok: false, reason: "stale_ref" };
    }
    const metadata = state.refs.get(input.ref);
    if (!metadata) {
      return { ok: false, reason: "missing_ref" };
    }
    return { ok: true, metadata };
  }

  private resolveOptionalRef(input: {
    browserId: string;
    ref?: string;
  }): { ok: true; metadata: BrowserRefMetadata | null } | BrowserRefFailure {
    if (!input.ref) {
      return { ok: true, metadata: null };
    }
    const resolved = this.resolveRef({
      browserId: input.browserId,
      ref: input.ref,
    });
    if (!resolved.ok) {
      return resolved;
    }
    return { ok: true, metadata: resolved.metadata };
  }
}

function readActionResult(value: unknown, staleWhenFalse: boolean): BrowserRefActionResult {
  if (value === false && staleWhenFalse) {
    return { ok: false, reason: "stale_ref" };
  }
  if (isActionFailure(value)) {
    return { ok: false, reason: value.reason };
  }
  return { ok: true };
}

function isActionFailure(value: unknown): value is BrowserRefFailure {
  if (!value || typeof value !== "object") {
    return false;
  }
  const reason = (value as Record<string, unknown>).reason;
  return reason === "stale_ref" || reason === "missing_ref";
}

function parseAriaSnapshot(value: unknown): RawAriaSnapshot {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== "object") {
    return emptySnapshot();
  }
  const record = parsed as Record<string, unknown>;
  if (record.marker !== ARIA_SNAPSHOT_SCRIPT_MARKER) {
    return emptySnapshot();
  }
  const root = parseSnapshotNode(record.root);
  return {
    marker: ARIA_SNAPSHOT_SCRIPT_MARKER,
    root: root ?? emptySnapshot().root,
    refs: parseRefs(record.refs),
    truncated: record.truncated === true,
    stats: parseStats(record.stats),
  };
}

function emptySnapshot(): RawAriaSnapshot {
  return {
    marker: ARIA_SNAPSHOT_SCRIPT_MARKER,
    root: { kind: "role", role: "document", name: "", tagName: "document", children: [] },
    refs: [],
    truncated: false,
    stats: { nodeCount: 0, refCount: 0, textLength: 0, iframeCount: 0, maxDepth: 0 },
  };
}

function parseSnapshotNode(value: unknown): SnapshotNode | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  if (kind !== "role" && kind !== "text" && kind !== "group") {
    return null;
  }
  return {
    kind,
    ...(readString(record.role) ? { role: readString(record.role) ?? undefined } : {}),
    ...(readString(record.name) ? { name: readString(record.name) ?? undefined } : {}),
    ...(readString(record.text) ? { text: readString(record.text) ?? undefined } : {}),
    ...(readString(record.tagName) ? { tagName: readString(record.tagName) ?? undefined } : {}),
    ...(readString(record.ref) ? { ref: readString(record.ref) ?? undefined } : {}),
    ...(parseFingerprint(record.fingerprint)
      ? { fingerprint: parseFingerprint(record.fingerprint) ?? undefined }
      : {}),
    attributes: readStringArray(record.attributes),
    children: Array.isArray(record.children)
      ? record.children.flatMap((child): SnapshotNode[] => {
          const parsed = parseSnapshotNode(child);
          return parsed ? [parsed] : [];
        })
      : [],
  };
}

function parseRefs(value: unknown): BrowserRefMetadata[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item): BrowserRefMetadata[] => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const record = item as Record<string, unknown>;
    const ref = readString(record.ref);
    const fingerprint = parseFingerprint(record.fingerprint);
    return ref && fingerprint ? [{ ref, fingerprint }] : [];
  });
}

function parseFingerprint(value: unknown): BrowserRefFingerprint | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const role = readString(record.role);
  const name = readString(record.name);
  const tagName = readString(record.tagName);
  const type = readString(record.type);
  const ariaLabel = readString(record.ariaLabel);
  if (role === null || name === null || tagName === null || type === null || ariaLabel === null) {
    return null;
  }
  return { role, name, tagName, type, ariaLabel };
}

function parseStats(value: unknown): BrowserAriaSnapshotStats {
  if (!value || typeof value !== "object") {
    return { nodeCount: 0, refCount: 0, textLength: 0 };
  }
  const record = value as Record<string, unknown>;
  return {
    nodeCount: readNumber(record.nodeCount) ?? 0,
    refCount: readNumber(record.refCount) ?? 0,
    textLength: readNumber(record.textLength) ?? 0,
    ...(readNumber(record.iframeCount) !== null
      ? { iframeCount: readNumber(record.iframeCount) ?? undefined }
      : {}),
    ...(readNumber(record.maxDepth) !== null
      ? { maxDepth: readNumber(record.maxDepth) ?? undefined }
      : {}),
  };
}

function renderSnapshot(root: SnapshotNode): string {
  const lines = renderNode(root, 0);
  return lines.length > 0 ? lines.join("\n") : "- document";
}

function renderNode(node: SnapshotNode, depth: number): string[] {
  if (node.kind === "group") {
    return (node.children ?? []).flatMap((child) => renderNode(child, depth));
  }
  const indent = "  ".repeat(depth);
  if (node.kind === "text") {
    return [`${indent}- text: ${JSON.stringify(node.text ?? "")}`];
  }
  const attrs = [...(node.attributes ?? [])];
  if (node.ref) {
    attrs.push(`ref=${node.ref}`);
  }
  const suffix = attrs.length > 0 ? ` [${attrs.join(" ")}]` : "";
  const ownLine = `${indent}- ${node.role ?? "generic"}${node.name ? ` ${JSON.stringify(node.name)}` : ""}${suffix}`;
  const childLines = (node.children ?? []).flatMap((child) => renderNode(child, depth + 1));
  return [ownLine, ...childLines];
}

function capRenderedSnapshot(
  snapshot: string,
  alreadyTruncated: boolean,
): { snapshot: string; truncated: boolean } {
  if (snapshot.length <= MAX_RENDERED_TEXT_LENGTH && !alreadyTruncated) {
    return { snapshot, truncated: false };
  }
  const availableLength = MAX_RENDERED_TEXT_LENGTH - TRUNCATION_MARKER.length - 1;
  const capped = snapshot.slice(0, Math.max(0, availableLength)).replace(/\n[^\n]*$/, "");
  return { snapshot: `${capped}\n${TRUNCATION_MARKER}`, truncated: true };
}

function buildClickScript(metadata: BrowserRefMetadata): string {
  return String.raw`(() => {
    const resolved = ${buildResolveExpression(metadata)};
    if (!resolved.ok) return resolved;
    const element = resolved.element;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    element.click();
    return { ok: true };
  })()`;
}

function buildFillScript(metadata: BrowserRefMetadata, value: string): string {
  return String.raw`(() => {
    const resolved = ${buildResolveExpression(metadata)};
    if (!resolved.ok) return resolved;
    const element = resolved.element;
    element.scrollIntoView({ block: 'center', inline: 'center' });
    element.focus();
    const nextValue = ${JSON.stringify(value)};
    if ('value' in element) {
      element.value = nextValue;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    }
    element.textContent = nextValue;
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: nextValue }));
    return { ok: true };
  })()`;
}

function buildTypeScript(metadata: BrowserRefMetadata | null, text: string): string {
  return String.raw`(() => {
    const resolved = ${metadata ? buildResolveExpression(metadata) : "{ ok: true, element: document.activeElement }"};
    if (!resolved.ok) return resolved;
    const element = resolved.element;
    if (!element) return false;
    element.scrollIntoView?.({ block: 'center', inline: 'center' });
    element.focus?.();
    const text = ${JSON.stringify(text)};
    if ('value' in element) {
      element.value = String(element.value || '') + text;
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    }
    element.textContent = String(element.textContent || '') + text;
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    return { ok: true };
  })()`;
}

function buildKeypressScript(metadata: BrowserRefMetadata | null, key: string): string {
  return String.raw`(() => {
    const resolved = ${metadata ? buildResolveExpression(metadata) : "{ ok: true, element: document.activeElement }"};
    if (!resolved.ok) return resolved;
    const element = resolved.element;
    if (!element) return false;
    element.focus?.();
    const key = ${JSON.stringify(key)};
    const eventInit = { bubbles: true, cancelable: true, key };
    element.dispatchEvent(new KeyboardEvent('keydown', eventInit));
    element.dispatchEvent(new KeyboardEvent('keypress', eventInit));
    element.dispatchEvent(new KeyboardEvent('keyup', eventInit));
    return { ok: true };
  })()`;
}

function buildSelectScript(metadata: BrowserRefMetadata, value: string): string {
  return String.raw`(() => {
    const resolved = ${buildResolveExpression(metadata)};
    if (!resolved.ok) return resolved;
    const element = resolved.element;
    element.scrollIntoView?.({ block: 'center', inline: 'center' });
    element.focus?.();
    const nextValue = ${JSON.stringify(value)};
    if ('value' in element) {
      element.value = nextValue;
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true };
    }
    return false;
  })()`;
}

function buildHoverScript(metadata: BrowserRefMetadata): string {
  return String.raw`(() => {
    const resolved = ${buildResolveExpression(metadata)};
    if (!resolved.ok) return resolved;
    const element = resolved.element;
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
    return { ok: true };
  })()`;
}

function buildDragScript(source: BrowserRefMetadata, target: BrowserRefMetadata): string {
  return String.raw`(() => {
    const sourceResolved = ${buildResolveExpression(source)};
    if (!sourceResolved.ok) return sourceResolved;
    const targetResolved = ${buildResolveExpression(target)};
    if (!targetResolved.ok) return targetResolved;
    const source = sourceResolved.element;
    const target = targetResolved.element;
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
    return { ok: true };
  })()`;
}

function buildRuntimeElementExpression(metadata: BrowserRefMetadata): string {
  return String.raw`(() => {
    const resolved = ${buildResolveExpression(metadata)};
    if (!resolved.ok) return null;
    return resolved.element;
  })()`;
}

function buildResolveExpression(metadata: BrowserRefMetadata): string {
  return `window.__PASEO_BROWSER_AUTOMATION__?.resolve(${JSON.stringify(metadata.ref)}, ${JSON.stringify(metadata.fingerprint)}) ?? { ok: false, reason: 'stale_ref' }`;
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
