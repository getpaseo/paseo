export type PendingTerminalModifiers = {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
};

const MODIFIER_DOM_KEYS = new Set([
  "Control",
  "Shift",
  "Alt",
  "Meta",
  "AltGraph",
  "OS",
]);

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
  if (
    key === "Unidentified" ||
    key === "Dead" ||
    key === "Compose" ||
    key === "Process"
  ) {
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

export function hasPendingTerminalModifiers(
  modifiers: PendingTerminalModifiers
): boolean {
  return modifiers.ctrl || modifiers.shift || modifiers.alt;
}

export function shouldInterceptDomTerminalKey(args: {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  pendingModifiers: PendingTerminalModifiers;
}): boolean {
  return (
    args.key.length > 1 ||
    args.ctrlKey ||
    args.altKey ||
    hasPendingTerminalModifiers(args.pendingModifiers)
  );
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
