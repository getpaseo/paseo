export interface BrowserShortcutPrefix {
  alt: boolean;
  code: string;
  codeFallback?: true;
  control: boolean;
  key?: string;
  meta: boolean;
  repeat?: false;
  shift: boolean;
  shiftedKey?: string;
}

export interface BrowserKeyboardPolicy {
  prefixes: BrowserShortcutPrefix[];
}

export interface BrowserShortcutInput {
  alt: boolean;
  browserId: string;
  code: string;
  control: boolean;
  key: string;
  meta: boolean;
  repeat: boolean;
  shift: boolean;
}

export type BrowserReservedShortcut = "new-tab" | "focus-url" | "reload" | "force-reload";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePrefix(value: unknown): BrowserShortcutPrefix | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.code !== "string" ||
    value.code.length === 0 ||
    typeof value.alt !== "boolean" ||
    typeof value.control !== "boolean" ||
    typeof value.meta !== "boolean" ||
    typeof value.shift !== "boolean" ||
    (value.key !== undefined && typeof value.key !== "string") ||
    (value.shiftedKey !== undefined && typeof value.shiftedKey !== "string") ||
    (value.codeFallback !== undefined && value.codeFallback !== true) ||
    (value.repeat !== undefined && value.repeat !== false)
  ) {
    return null;
  }
  return {
    alt: value.alt,
    code: value.code,
    ...(value.codeFallback === true ? { codeFallback: true } : {}),
    control: value.control,
    ...(typeof value.key === "string" ? { key: value.key.toLowerCase() } : {}),
    meta: value.meta,
    ...(value.repeat === false ? { repeat: false } : {}),
    shift: value.shift,
    ...(typeof value.shiftedKey === "string" ? { shiftedKey: value.shiftedKey.toLowerCase() } : {}),
  };
}

export function parseBrowserKeyboardPolicy(value: unknown): BrowserKeyboardPolicy | null {
  if (!isRecord(value) || !Array.isArray(value.prefixes)) {
    return null;
  }
  const prefixes: BrowserShortcutPrefix[] = [];
  for (const entry of value.prefixes) {
    const prefix = parsePrefix(entry);
    if (!prefix) {
      return null;
    }
    prefixes.push(prefix);
  }
  return { prefixes };
}

export function parseBrowserShortcutInput(value: unknown): BrowserShortcutInput | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.browserId !== "string" ||
    value.browserId.length === 0 ||
    typeof value.key !== "string" ||
    typeof value.code !== "string" ||
    typeof value.alt !== "boolean" ||
    typeof value.control !== "boolean" ||
    typeof value.meta !== "boolean" ||
    typeof value.shift !== "boolean"
  ) {
    return null;
  }
  return {
    alt: value.alt,
    browserId: value.browserId,
    code: value.code,
    control: value.control,
    key: value.key,
    meta: value.meta,
    repeat: value.repeat === true,
    shift: value.shift,
  };
}

export function classifyBrowserReservedShortcut(
  input: {
    alt: boolean;
    control: boolean;
    key: string;
    meta: boolean;
    shift: boolean;
    type: string;
  },
  platform: {
    isMac: boolean;
  },
): BrowserReservedShortcut | null {
  const hasPlatformModifier = platform.isMac
    ? input.meta && !input.control
    : input.control && !input.meta;
  if (input.type !== "keyDown" || input.alt || !hasPlatformModifier) {
    return null;
  }
  const key = input.key.toLowerCase();
  if (!input.shift && key === "t") return "new-tab";
  if (!input.shift && key === "l") return "focus-url";
  if (key !== "r") return null;
  return input.shift ? "force-reload" : "reload";
}
