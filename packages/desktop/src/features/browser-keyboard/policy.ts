export interface BrowserShortcutPrefix {
  alt: boolean;
  code: string;
  codeFallback?: true;
  control: boolean;
  editable?: false;
  key?: string;
  meta: boolean;
  repeat?: false;
  shift: boolean;
  shiftedKey?: string;
}

export interface BrowserKeyboardPolicy {
  menuPrefixes: BrowserShortcutPrefix[];
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

export interface BrowserShortcutMatchInput {
  alt: boolean;
  code: string;
  control: boolean;
  editable?: boolean;
  key: string;
  meta: boolean;
  repeat: boolean;
  shift: boolean;
}

export type BrowserReservedShortcut = "focus-url" | "reload" | "force-reload";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasValidOptionalPrefixFields(value: Record<string, unknown>): boolean {
  return (
    (value.key === undefined || typeof value.key === "string") &&
    (value.shiftedKey === undefined || typeof value.shiftedKey === "string") &&
    (value.codeFallback === undefined || value.codeFallback === true) &&
    (value.editable === undefined || value.editable === false) &&
    (value.repeat === undefined || value.repeat === false)
  );
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
    !hasValidOptionalPrefixFields(value)
  ) {
    return null;
  }
  return {
    alt: value.alt,
    code: value.code,
    ...(value.codeFallback === true ? { codeFallback: true } : {}),
    control: value.control,
    ...(value.editable === false ? { editable: false } : {}),
    ...(typeof value.key === "string" ? { key: value.key.toLowerCase() } : {}),
    meta: value.meta,
    ...(value.repeat === false ? { repeat: false } : {}),
    shift: value.shift,
    ...(typeof value.shiftedKey === "string" ? { shiftedKey: value.shiftedKey.toLowerCase() } : {}),
  };
}

function parsePrefixes(value: unknown): BrowserShortcutPrefix[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const prefixes: BrowserShortcutPrefix[] = [];
  for (const entry of value) {
    const prefix = parsePrefix(entry);
    if (!prefix) {
      return null;
    }
    prefixes.push(prefix);
  }
  return prefixes;
}

export function parseBrowserKeyboardPolicy(value: unknown): BrowserKeyboardPolicy | null {
  if (!isRecord(value)) {
    return null;
  }
  const menuPrefixes = parsePrefixes(value.menuPrefixes);
  const prefixes = parsePrefixes(value.prefixes);
  return menuPrefixes && prefixes ? { menuPrefixes, prefixes } : null;
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

function matchesCode(prefixCode: string, inputCode: string): boolean {
  if (prefixCode !== "Digit") {
    return prefixCode === inputCode;
  }
  return /^(?:Digit|Numpad)[1-9]$/.test(inputCode);
}

function matchesPrefix(prefix: BrowserShortcutPrefix, input: BrowserShortcutMatchInput): boolean {
  if (
    prefix.alt !== input.alt ||
    prefix.control !== input.control ||
    prefix.meta !== input.meta ||
    prefix.shift !== input.shift ||
    (prefix.editable === false && input.editable === true) ||
    (prefix.repeat === false && input.repeat)
  ) {
    return false;
  }
  if (prefix.key === undefined) {
    return matchesCode(prefix.code, input.code);
  }
  const key = input.key.toLowerCase();
  if (key === prefix.key) {
    return true;
  }
  if (prefix.shift && prefix.shiftedKey !== undefined && key === prefix.shiftedKey) {
    return true;
  }
  return (prefix.alt || prefix.codeFallback === true) && matchesCode(prefix.code, input.code);
}

export function matchesBrowserShortcutPrefixes(
  prefixes: BrowserShortcutPrefix[],
  input: BrowserShortcutMatchInput,
): boolean {
  return prefixes.some((prefix) => matchesPrefix(prefix, input));
}

export function matchesBrowserShortcutPolicy(
  policy: BrowserKeyboardPolicy,
  input: BrowserShortcutMatchInput,
): boolean {
  return matchesBrowserShortcutPrefixes(policy.prefixes, input);
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
  if (!input.shift && key === "l") return "focus-url";
  if (key !== "r") return null;
  return input.shift ? "force-reload" : "reload";
}
