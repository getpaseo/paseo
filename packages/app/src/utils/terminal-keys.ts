export interface PendingTerminalModifiers {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

const MODIFIER_DOM_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "AltGraph", "OS"]);

const DOM_KEY_ALIASES: Record<string, string> = {
  Esc: "Escape",
  Left: "ArrowLeft",
  Right: "ArrowRight",
  Up: "ArrowUp",
  Down: "ArrowDown",
  Del: "Delete",
  Spacebar: " ",
  Space: " ",
};

const SUPPORTED_SPECIAL_KEYS = new Set([
  "Enter",
  "Tab",
  "Backspace",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "Insert",
  "Delete",
  "PageUp",
  "PageDown",
  "F1",
  "F2",
  "F3",
  "F4",
  "F5",
  "F6",
  "F7",
  "F8",
  "F9",
  "F10",
  "F11",
  "F12",
]);

export function isTerminalModifierDomKey(rawKey: string): boolean {
  return MODIFIER_DOM_KEYS.has(rawKey);
}

export function normalizeDomTerminalKey(rawKey: string): string | null {
  if (!rawKey) {
    return null;
  }

  const key = DOM_KEY_ALIASES[rawKey] ?? rawKey;
  if (key === "Unidentified" || key === "Dead" || key === "Compose" || key === "Process") {
    return null;
  }

  if (key.length === 1) {
    return key;
  }

  if (SUPPORTED_SPECIAL_KEYS.has(key)) {
    return key;
  }

  return null;
}

export function normalizeTerminalTransportKey(key: string): string {
  if (key.length === 1) {
    return key.toLowerCase();
  }
  return key;
}

export function hasPendingTerminalModifiers(modifiers: PendingTerminalModifiers): boolean {
  return modifiers.ctrl || modifiers.shift || modifiers.alt;
}

interface AppleHandheldDetectionInput {
  userAgent: string | null | undefined;
  platform: string | null | undefined;
  maxTouchPoints: number | null | undefined;
}

// iPadOS 13+ WKWebView reports navigator.platform="MacIntel" and a Mac UA string. Distinguish
// iPad/iPhone from real macOS via maxTouchPoints, which is 0 on macOS and >1 on iPadOS/iOS.
export function isAppleHandheldPlatform(input: AppleHandheldDetectionInput): boolean {
  const userAgent = input.userAgent ?? "";
  const platform = input.platform ?? "";
  const touchPoints = input.maxTouchPoints ?? 0;
  if (/iPad|iPhone|iPod/.test(userAgent)) {
    return true;
  }
  if (/Mac/i.test(platform) && touchPoints > 1) {
    return true;
  }
  return false;
}

export function shouldInterceptDomTerminalKey(args: {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  pendingModifiers: PendingTerminalModifiers;
  enhancedInputActive?: boolean;
  isAppleHandheld?: boolean;
}): boolean {
  if (hasPendingTerminalModifiers(args.pendingModifiers)) {
    return true;
  }
  if (args.key === "Enter" && (args.shiftKey || args.ctrlKey || args.altKey || args.metaKey)) {
    return Boolean(args.enhancedInputActive);
  }
  // COMPAT(xterm-ipad-ctrl-c): WebKit sends keyCode=13 for hardware-kbd Ctrl+C on iPad, so
  // xterm.js emits \r instead of \x03. Upstream: xtermjs/xterm.js#5721, targeting xterm.js 7.0.0.
  // Drop this block and the isAppleHandheld plumbing once @xterm/xterm is bumped past it.
  if (
    args.isAppleHandheld &&
    args.ctrlKey &&
    !args.metaKey &&
    !args.altKey &&
    !args.shiftKey &&
    (args.key === "c" || args.key === "C")
  ) {
    return true;
  }
  return false;
}

export function mergeTerminalModifiers(args: {
  pendingModifiers: PendingTerminalModifiers;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}): {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
} {
  const { pendingModifiers, ctrlKey, shiftKey, altKey, metaKey } = args;
  return {
    ctrl: ctrlKey || pendingModifiers.ctrl,
    shift: shiftKey || pendingModifiers.shift,
    alt: altKey || pendingModifiers.alt,
    meta: metaKey,
  };
}

export function mapTerminalDataToKey(data: string): string | null {
  if (!data || data.length !== 1) {
    return null;
  }

  if (data === "\r" || data === "\n") {
    return "Enter";
  }
  if (data === "\t") {
    return "Tab";
  }
  if (data === "\x7f" || data === "\b") {
    return "Backspace";
  }
  if (data === "\x1b") {
    return "Escape";
  }

  const code = data.charCodeAt(0);
  // Only map printable ASCII for modifier fallback; keep control bytes raw.
  if (code >= 0x20 && code <= 0x7e) {
    return data;
  }

  return null;
}

export function resolvePendingModifierDataInput(args: {
  data: string;
  pendingModifiers: PendingTerminalModifiers;
}):
  | {
      mode: "key";
      key: string;
      clearPendingModifiers: true;
    }
  | {
      mode: "raw";
      clearPendingModifiers: boolean;
    } {
  if (!hasPendingTerminalModifiers(args.pendingModifiers)) {
    return {
      mode: "raw",
      clearPendingModifiers: false,
    };
  }

  const mappedKey = mapTerminalDataToKey(args.data);
  if (!mappedKey) {
    return {
      mode: "raw",
      clearPendingModifiers: true,
    };
  }

  return {
    mode: "key",
    key: mappedKey,
    clearPendingModifiers: true,
  };
}

export interface TerminalShortcutInput {
  key: string;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
}

// macOS-standard terminal shortcuts that xterm.js's built-in translation does not
// emit in a form readline understands. For modifier + arrow keys, xterm always
// produces the CSI modifier-encoded form (Alt+Left -> `\x1b[1;3D`, Meta+Left ->
// `\x1b[1;9D`), but the default bash/zsh readline on macOS binds word/line motion
// to the legacy Esc-prefix and control forms instead:
//   backward-word  = `\eb`   forward-word = `\ef`
//   beginning-of-line = `\C-a` (\x01)   end-of-line = `\C-e` (\x05)
// We intercept the modifier+arrow combos and return the readline-default bytes so
// Option / Cmd + arrows jump by word / line out of the box.
//
// `macOptionIsMeta: true` already covers Option + letter (Option+B -> `\x1bb`), so
// this only fills the arrow-key gap. Returns null when the combo is not one we
// remap, so the caller can let xterm handle it normally.
export function resolveMacTerminalShortcut(input: TerminalShortcutInput): string | null {
  // Require exactly one of alt/meta and no shift/ctrl, so we don't clobber
  // selection (shift) or other modifier combos.
  if (input.shift || input.ctrl || (input.alt && input.meta) || (!input.alt && !input.meta)) {
    return null;
  }

  if (input.meta) {
    switch (input.key) {
      case "ArrowLeft":
        return "\x01"; // Ctrl-A: beginning-of-line
      case "ArrowRight":
        return "\x05"; // Ctrl-E: end-of-line
    }
  } else {
    switch (input.key) {
      case "ArrowLeft":
        return "\x1bb"; // Esc+b: backward-word
      case "ArrowRight":
        return "\x1bf"; // Esc+f: forward-word
    }
  }

  return null;
}
