import {
  matchesKeyboardShortcutContext,
  type KeyboardShortcutInput,
  type ParsedShortcutBinding,
} from "./keyboard-shortcuts";
import type { KeyCombo } from "./shortcut-string";

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

export interface BrowserShortcutInput extends KeyboardShortcutInput {
  browserId: string;
}

interface BrowserShortcutPolicyInput {
  bindings: readonly ParsedShortcutBinding[];
  isMac: boolean;
  isDesktop: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseBrowserShortcutInput(value: unknown): BrowserShortcutInput | null {
  if (!isRecord(value)) {
    return null;
  }
  const { browserId, code, key } = value;
  if (typeof browserId !== "string" || browserId.length === 0) {
    return null;
  }
  if (typeof code !== "string" || typeof key !== "string") {
    return null;
  }
  if (
    typeof value.alt !== "boolean" ||
    typeof value.control !== "boolean" ||
    typeof value.meta !== "boolean" ||
    typeof value.shift !== "boolean" ||
    (value.repeat !== undefined && typeof value.repeat !== "boolean")
  ) {
    return null;
  }

  return {
    browserId,
    key,
    code,
    altKey: value.alt,
    ctrlKey: value.control,
    metaKey: value.meta,
    shiftKey: value.shift,
    repeat: value.repeat ?? false,
  };
}

function prefixFromCombo(combo: KeyCombo, isMac: boolean): BrowserShortcutPrefix | null {
  const prefix: BrowserShortcutPrefix = {
    alt: combo.alt === true,
    code: combo.code,
    control: combo.ctrl === true || (!isMac && combo.mod === true),
    meta: combo.meta === true || (isMac && combo.mod === true),
    shift: combo.shift === true,
  };
  if (combo.codeFallback === true) {
    prefix.codeFallback = true;
  }
  if (combo.key) {
    prefix.key = combo.key;
  }
  if (combo.repeat === false) {
    prefix.repeat = false;
  }
  if (combo.shiftedKey) {
    prefix.shiftedKey = combo.shiftedKey;
  }
  return prefix.meta || prefix.control || prefix.alt ? prefix : null;
}

function prefixesFromBinding(
  binding: ParsedShortcutBinding,
  isMac: boolean,
): BrowserShortcutPrefix[] | null {
  const prefixes: BrowserShortcutPrefix[] = [];
  for (const combo of binding.parsedChord) {
    const prefix = prefixFromCombo(combo, isMac);
    if (!prefix) {
      return null;
    }
    prefixes.push(prefix);
  }
  return prefixes;
}

function prefixKey(prefix: BrowserShortcutPrefix): string {
  return [
    prefix.code,
    prefix.key ?? "",
    prefix.shiftedKey ?? "",
    prefix.codeFallback ?? "",
    prefix.control,
    prefix.meta,
    prefix.alt,
    prefix.shift,
    prefix.repeat ?? "",
  ].join(":");
}

export function buildBrowserShortcutPolicy(
  input: BrowserShortcutPolicyInput,
): BrowserShortcutPrefix[] {
  const prefixes = new Map<string, BrowserShortcutPrefix>();
  const context = {
    isMac: input.isMac,
    isDesktop: input.isDesktop,
    focusScope: "browser" as const,
    commandCenterOpen: false,
  };

  for (const binding of input.bindings) {
    if (!matchesKeyboardShortcutContext(binding.when, context)) {
      continue;
    }
    const bindingPrefixes = prefixesFromBinding(binding, input.isMac);
    if (!bindingPrefixes) {
      continue;
    }
    for (const prefix of bindingPrefixes) {
      prefixes.set(prefixKey(prefix), prefix);
    }
  }

  return [...prefixes.values()];
}
