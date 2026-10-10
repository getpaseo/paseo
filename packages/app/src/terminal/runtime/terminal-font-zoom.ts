export type TerminalFontZoomDirection = "in" | "out" | "reset";

export const MIN_TERMINAL_FONT_ZOOM = 8;
export const MAX_TERMINAL_FONT_ZOOM = 32;
/** Survives a renderer reload. Separate from codeFontSize, which also sizes the editor and clamps to 9–22. */
export const TERMINAL_FONT_SIZE_STORAGE_KEY = "@paseo:terminal-font-size";

export interface TerminalFontSizeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const HELPER_TEXTAREA_CLASS = "xterm-helper-textarea";
const WHEEL_PIXELS_PER_STEP = 100;
const MAX_WHEEL_STEPS = 4;

export interface TerminalFontZoomTarget {
  textarea?: { classList?: { contains(token: string): boolean } } | null;
  options: { fontSize?: number };
}

export interface TerminalFontZoomRegistration<T extends TerminalFontZoomTarget> {
  terminal: T;
  fit: (request: { forceRefresh: true; shouldClaim: true }) => void;
  baseFontSize: number;
}

interface ZoomEntry<T extends TerminalFontZoomTarget> {
  terminal: T;
  fit: (request: { forceRefresh: true; shouldClaim: true }) => void;
  baseFontSize: number;
  zoomed: boolean;
}

type ZoomHost = typeof globalThis & {
  paseoConsumeTerminalZoom?: (direction: string) => boolean;
  __paseoTerminalZoomWheel?: boolean;
};

export function terminalZoomDirectionFromKeyboardEvent(event: {
  type?: string;
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
}): TerminalFontZoomDirection | null {
  if (event.type !== undefined && event.type !== "keydown") return null;
  if (event.isComposing || event.altKey) return null;
  if (event.metaKey === event.ctrlKey) return null;
  if (event.key === "=" || event.key === "+" || event.key === "Add") return "in";
  if (event.key === "-" || event.key === "_" || event.key === "Subtract") return "out";
  if (event.key === "0" && !event.shiftKey) return "reset";
  return null;
}

/** Positive steps grow the font. Pixel deltas accumulate until 100px, one mouse notch. */
export function terminalFontZoomStepsFromWheel(
  event: {
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
    shiftKey?: boolean;
    deltaY: number;
    deltaMode?: number;
  },
  remainder: number,
): { steps: number; remainder: number } | null {
  if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null;
  if (!event.deltaY) return { steps: 0, remainder };
  if ((event.deltaMode ?? 0) !== 0) {
    return { steps: event.deltaY < 0 ? 1 : -1, remainder };
  }
  const next = remainder + event.deltaY;
  const taken = Math.trunc(next / WHEEL_PIXELS_PER_STEP);
  return { steps: -taken, remainder: next - taken * WHEEL_PIXELS_PER_STEP };
}

export function isTerminalFontZoomDirection(
  direction: string,
): direction is TerminalFontZoomDirection {
  return direction === "in" || direction === "out" || direction === "reset";
}

export function nextTerminalFontSize(
  current: number,
  base: number,
  direction: TerminalFontZoomDirection,
): number {
  const resolvedBase = base > 0 ? base : current;
  const resolvedCurrent = current > 0 ? current : resolvedBase;
  if (direction === "reset") return resolvedBase;
  if (direction === "in") return Math.min(MAX_TERMINAL_FONT_ZOOM, resolvedCurrent + 1);
  return Math.max(MIN_TERMINAL_FONT_ZOOM, resolvedCurrent - 1);
}

export class TerminalFontZoomRegistry<T extends TerminalFontZoomTarget> {
  private readonly entries = new Map<T, ZoomEntry<T>>();

  constructor(private readonly storage: TerminalFontSizeStorage | null = null) {}

  register(input: TerminalFontZoomRegistration<T>): () => void {
    const baseFontSize = input.baseFontSize > 0 ? input.baseFontSize : 13;
    const restored = restoreStoredTerminalFontSize(this.storage, baseFontSize);
    if (restored !== null) input.terminal.options.fontSize = restored;
    this.entries.set(input.terminal, {
      terminal: input.terminal,
      fit: input.fit,
      baseFontSize,
      zoomed: restored !== null,
    });
    return () => {
      this.entries.delete(input.terminal);
    };
  }

  /** Settings font size, or null when a zoom step is holding this terminal. */
  settingsFontSize(terminal: T, fontSize: number): number | null {
    const entry = this.entries.get(terminal);
    if (!entry || !entry.zoomed) {
      if (entry) entry.baseFontSize = fontSize;
      return fontSize;
    }
    return null;
  }

  consume(direction: TerminalFontZoomDirection, activeElement: unknown): boolean {
    const entry = this.focusedEntry(activeElement);
    if (!entry) return false;
    const current = entry.terminal.options.fontSize ?? entry.baseFontSize;
    const next = nextTerminalFontSize(current, entry.baseFontSize, direction);
    entry.zoomed = next !== entry.baseFontSize;
    writeStoredTerminalFontSize(this.storage, next, entry.baseFontSize);
    if (next === current) return true;
    entry.terminal.options.fontSize = next;
    entry.fit({ forceRefresh: true, shouldClaim: true });
    return true;
  }

  private focusedEntry(activeElement: unknown): ZoomEntry<T> | null {
    if (!isHelperTextarea(activeElement)) return null;
    for (const entry of this.entries.values()) {
      if (entry.terminal.textarea === activeElement) return entry;
    }
    return null;
  }
}

function isHelperTextarea(
  activeElement: unknown,
): activeElement is { classList: { contains(token: string): boolean } } {
  if (typeof activeElement !== "object" || activeElement === null) return false;
  if (!("classList" in activeElement)) return false;
  const classList = activeElement.classList;
  return (
    typeof classList === "object" &&
    classList !== null &&
    "contains" in classList &&
    typeof classList.contains === "function" &&
    classList.contains(HELPER_TEXTAREA_CLASS)
  );
}

const sharedRegistry = new TerminalFontZoomRegistry<TerminalFontZoomTarget>(
  browserTerminalFontSizeStorage(),
);

export function readStoredTerminalFontSize(storage: TerminalFontSizeStorage | null): number | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(TERMINAL_FONT_SIZE_STORAGE_KEY);
    if (raw == null || raw === "") return null;
    const size = Number(raw);
    if (!Number.isInteger(size) || size < MIN_TERMINAL_FONT_ZOOM || size > MAX_TERMINAL_FONT_ZOOM) {
      return null;
    }
    return size;
  } catch {
    return null;
  }
}

export function writeStoredTerminalFontSize(
  storage: TerminalFontSizeStorage | null,
  size: number,
  base: number,
): void {
  if (!storage) return;
  try {
    if (size === base) storage.removeItem(TERMINAL_FONT_SIZE_STORAGE_KEY);
    else storage.setItem(TERMINAL_FONT_SIZE_STORAGE_KEY, String(size));
  } catch {
    // Private mode and locked storage still keep the live zoom.
  }
}

function restoreStoredTerminalFontSize(
  storage: TerminalFontSizeStorage | null,
  base: number,
): number | null {
  const stored = readStoredTerminalFontSize(storage);
  if (stored === null) return null;
  if (stored === base) {
    writeStoredTerminalFontSize(storage, stored, base);
    return null;
  }
  return stored;
}

function browserTerminalFontSizeStorage(): TerminalFontSizeStorage | null {
  try {
    const storage = globalThis.localStorage;
    if (!storage || typeof storage.getItem !== "function") return null;
    return storage;
  } catch {
    return null;
  }
}

export function sharedTerminalFontZoomRegistry(): TerminalFontZoomRegistry<TerminalFontZoomTarget> {
  return sharedRegistry;
}

function helperTextareaFromWheelTarget(target: EventTarget | null): unknown {
  if (typeof target !== "object" || target === null || !("closest" in target)) return null;
  const closest = (target as { closest?: (selector: string) => unknown }).closest;
  if (typeof closest !== "function") return null;
  const root = closest.call(target, ".xterm");
  if (typeof root !== "object" || root === null || !("querySelector" in root)) return null;
  const query = (root as { querySelector?: (selector: string) => unknown }).querySelector;
  if (typeof query !== "function") return null;
  return query.call(root, `.${HELPER_TEXTAREA_CLASS}`);
}

function installTerminalFontZoomWheel(
  registry: TerminalFontZoomRegistry<TerminalFontZoomTarget>,
): void {
  const host = globalThis as ZoomHost;
  if (
    host.__paseoTerminalZoomWheel ||
    typeof document === "undefined" ||
    typeof document.addEventListener !== "function"
  ) {
    return;
  }
  host.__paseoTerminalZoomWheel = true;
  let remainder = 0;
  let remainderTarget: unknown = null;
  document.addEventListener(
    "wheel",
    (event) => {
      const textarea = helperTextareaFromWheelTarget(event.target);
      const continued = textarea !== null && textarea === remainderTarget;
      const zoom = terminalFontZoomStepsFromWheel(event, continued ? remainder : 0);
      if (!zoom || !textarea) {
        remainder = 0;
        remainderTarget = null;
        return;
      }
      remainderTarget = textarea;
      remainder = zoom.remainder;
      event.preventDefault();
      event.stopPropagation();
      if (zoom.steps === 0) return;
      const direction: TerminalFontZoomDirection = zoom.steps > 0 ? "in" : "out";
      const count = Math.min(MAX_WHEEL_STEPS, Math.abs(zoom.steps));
      for (let index = 0; index < count; index += 1) {
        if (!registry.consume(direction, textarea)) return;
      }
    },
    { capture: true, passive: false },
  );
}

export function installTerminalFontZoomBridge(
  registry: TerminalFontZoomRegistry<TerminalFontZoomTarget> = sharedRegistry,
): void {
  const host = globalThis as ZoomHost;
  if (!host.paseoConsumeTerminalZoom) {
    host.paseoConsumeTerminalZoom = (direction) => {
      if (!isTerminalFontZoomDirection(direction)) return false;
      const active = typeof document === "undefined" ? null : document.activeElement;
      return registry.consume(direction, active);
    };
  }
  installTerminalFontZoomWheel(registry);
}

export function consumeInstalledTerminalFontZoom(direction: string): boolean {
  const consume = (globalThis as ZoomHost).paseoConsumeTerminalZoom;
  return consume?.(direction) === true;
}

export function consumeTerminalZoomKeyboardEvent(event: {
  type?: string;
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}): boolean {
  const direction = terminalZoomDirectionFromKeyboardEvent(event);
  if (!direction || !consumeInstalledTerminalFontZoom(direction)) return false;
  event.preventDefault();
  event.stopPropagation();
  return true;
}
