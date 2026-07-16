import {
  type ChordState,
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
  editable?: false;
  key?: string;
  meta: boolean;
  repeat?: false;
  shift: boolean;
  shiftedKey?: string;
}

export interface BrowserShortcutInput extends KeyboardShortcutInput {
  browserId: string;
}

export interface BrowserKeyboardPolicy {
  menuPrefixes: BrowserShortcutPrefix[];
  prefixes: BrowserShortcutPrefix[];
}

interface BrowserShortcutPolicyInput {
  bindings: readonly ParsedShortcutBinding[];
  chordState?: ChordState;
  isMac: boolean;
  isDesktop: boolean;
}

export function shouldPublishBrowserShortcutPolicy(input: {
  isBrowserInput: boolean;
  nextChordState: ChordState;
  previousChordState: ChordState;
}): boolean {
  return (
    input.isBrowserInput || (input.previousChordState.step > 0 && input.nextChordState.step === 0)
  );
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

function prefixFromCombo(
  combo: KeyCombo,
  isMac: boolean,
  editable: false | undefined,
): BrowserShortcutPrefix | null {
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
  if (editable === false) {
    prefix.editable = false;
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

function isBrowserNativeNavigationPrefix(prefix: BrowserShortcutPrefix, isMac: boolean): boolean {
  return (
    isMac &&
    prefix.meta &&
    !prefix.control &&
    !prefix.alt &&
    !prefix.shift &&
    (prefix.code === "BracketLeft" || prefix.code === "BracketRight")
  );
}

function canCrossBrowserBoundary(binding: ParsedShortcutBinding, isMac: boolean): boolean {
  return binding.parsedChord.every((combo) => {
    const prefix = prefixFromCombo(combo, isMac, binding.when?.editable);
    return prefix !== null && !isBrowserNativeNavigationPrefix(prefix, isMac);
  });
}

function prefixKey(prefix: BrowserShortcutPrefix): string {
  return [
    prefix.code,
    prefix.key ?? "",
    prefix.shiftedKey ?? "",
    prefix.codeFallback ?? "",
    prefix.editable ?? "",
    prefix.control,
    prefix.meta,
    prefix.alt,
    prefix.shift,
    prefix.repeat ?? "",
  ].join(":");
}

function buildBrowserShortcutPrefixes(input: BrowserShortcutPolicyInput): BrowserShortcutPrefix[] {
  const prefixes = new Map<string, BrowserShortcutPrefix>();
  const context = {
    isMac: input.isMac,
    isDesktop: input.isDesktop,
    focusScope: "browser" as const,
    commandCenterOpen: false,
  };

  const candidates =
    input.chordState && input.chordState.step > 0
      ? input.chordState.candidateIndices
      : input.bindings.map((_, index) => index);
  const step = input.chordState?.step ?? 0;

  for (const index of candidates) {
    const binding = input.bindings[index];
    if (!binding) {
      continue;
    }
    if (!matchesKeyboardShortcutContext(binding.when, context)) {
      continue;
    }
    if (!canCrossBrowserBoundary(binding, input.isMac)) {
      continue;
    }
    const combo = binding.parsedChord[step];
    if (!combo) {
      continue;
    }
    const prefix = prefixFromCombo(combo, input.isMac, binding.when?.editable);
    if (!prefix) {
      continue;
    }
    prefixes.set(prefixKey(prefix), prefix);
  }

  return [...prefixes.values()];
}

export function buildBrowserKeyboardPolicy(
  input: BrowserShortcutPolicyInput,
): BrowserKeyboardPolicy {
  const idlePrefixes = buildBrowserShortcutPrefixes({ ...input, chordState: undefined });
  const prefixes =
    input.chordState && input.chordState.step > 0
      ? buildBrowserShortcutPrefixes(input)
      : idlePrefixes;
  const menuPrefixes = [...idlePrefixes];
  if (!input.isMac) {
    const closeWindowGuard: BrowserShortcutPrefix = {
      alt: false,
      code: "KeyW",
      control: true,
      key: "w",
      meta: false,
      shift: false,
    };
    if (!menuPrefixes.some((prefix) => prefixKey(prefix) === prefixKey(closeWindowGuard))) {
      menuPrefixes.push(closeWindowGuard);
    }
  }
  return { menuPrefixes, prefixes };
}
