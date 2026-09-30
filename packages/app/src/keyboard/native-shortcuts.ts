import {
  parseBindingChord,
  type KeyboardShortcutInput,
  type ParsedShortcutBinding,
} from "@/keyboard/keyboard-shortcuts";

/**
 * Binding ids handed to iOS as `UIKeyCommand`s.
 *
 * Half the desktop map has no native counterpart: every `workspace.pane.*`
 * binding needs split panes, and `supportsDesktopPaneSplits()` is web-only.
 */
export const NATIVE_HARDWARE_SHORTCUT_BINDING_IDS: readonly string[] = [
  "workspace-new-cmd-n-mac",
  "sidebar-toggle-left-mac-cmd-b",
  "command-center-toggle-cmd-k-mac",
  "workspace-project-pick-cmd-p-mac",
  "agent-new-cmd-shift-o-mac",
  "message-input-focus-cmd-l-mac",
  "settings-toggle-cmd-comma-mac",
  "agent-interrupt",
];

/**
 * DOM `code`s the terminal takes back while it holds the keyboard.
 *
 * A registered key command is consumed before the focused surface sees it, so
 * a permanently registered Escape would swallow the Escape vim inside a
 * terminal tab is waiting for. Filtering after the fact is not an option — the
 * press never reaches the terminal — so the key leaves the registered list
 * entirely, driven by `keyboard/native-terminal-keyboard.ts`.
 *
 * Reserved by key rather than by binding id because UIKit registers keys: more
 * than one binding carries Escape, and every one of them has to go or the key
 * stays registered and the carve-out does nothing.
 */
export const TERMINAL_RESERVED_NATIVE_KEY_CODES: ReadonlySet<string> = new Set(["Escape"]);

/**
 * DOM `code`s that cross to UIKit as one of its named input constants instead
 * of a literal character. `UIKeyCommand` spells these as sentinel strings
 * (`UIKeyCommand.inputEscape`) that JS has no business hardcoding, so the code
 * travels over the bridge and the Swift module resolves it. Anything absent
 * here is dropped rather than registered under a character iOS never sends.
 */
const NATIVE_NAMED_KEY_CODES: ReadonlySet<string> = new Set([
  "Escape",
  "Enter",
  "ArrowUp",
  "ArrowDown",
]);

/**
 * Keys an overlay may ask for on top of the binding table, registered only
 * while an overlay that wants them is topmost.
 *
 * A `UIKeyCommand` is taken from whatever holds focus, so these cannot be
 * registered permanently: Enter would stop submitting in every text field and
 * the arrows would stop moving the caret. Backspace is deliberately absent —
 * the command center pops its scope with it on web, and registering it would
 * stop the search field deleting text.
 */
const NATIVE_OVERLAY_KEY_CODES: ReadonlySet<string> = new Set(["Enter", "ArrowUp", "ArrowDown"]);

/**
 * Commands for the keys the topmost overlay asked for.
 *
 * These carry the bare key name as their combo, which is what comes back when
 * the press fires and what `dispatchTopNativeOverlayKey` matches on. They are
 * not bindings and never reach the resolver.
 */
export function buildNativeOverlayKeyCommands(keys: readonly string[]): NativeKeyCommand[] {
  const commands: NativeKeyCommand[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    if (!NATIVE_OVERLAY_KEY_CODES.has(key) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    commands.push({
      combo: key,
      input: "",
      namedKey: key,
      command: false,
      alternate: false,
      control: false,
      shift: false,
    });
  }
  return commands;
}

export interface NativeKeyCommand {
  combo: string;
  /** The literal character `UIKeyCommand` matches, empty when `namedKey` is set. */
  input: string;
  /** A `NATIVE_NAMED_KEY_CODES` entry Swift maps to a UIKit constant, else empty. */
  namedKey: string;
  command: boolean;
  alternate: boolean;
  control: boolean;
  shift: boolean;
}

/**
 * `UIKeyCommand` takes one input and a modifier mask, so a binding only makes
 * it across as a single combo whose key is either a literal character or a
 * named key iOS has a constant for. Chords and `Digit` wildcards are dropped.
 */
export function buildNativeKeyCommands(
  bindings: readonly ParsedShortcutBinding[],
  options: { isTerminalFocused?: boolean } = {},
): NativeKeyCommand[] {
  const commands: NativeKeyCommand[] = [];
  const registered = new Set<string>();
  for (const bindingId of NATIVE_HARDWARE_SHORTCUT_BINDING_IDS) {
    const binding = bindings.find((candidate) => candidate.id === bindingId);
    if (!binding || binding.parsedChord.length !== 1) {
      continue;
    }
    const combo = binding.parsedChord[0];
    if (options.isTerminalFocused && TERMINAL_RESERVED_NATIVE_KEY_CODES.has(combo.code)) {
      continue;
    }
    const namedKey = combo.key === undefined ? combo.code : "";
    if (namedKey !== "" && !NATIVE_NAMED_KEY_CODES.has(namedKey)) {
      continue;
    }
    const command: NativeKeyCommand = {
      combo: binding.combo,
      input: combo.key ?? "",
      namedKey,
      command: combo.meta === true || combo.mod === true,
      alternate: combo.alt === true,
      control: combo.ctrl === true,
      shift: combo.shift === true,
    };
    // Several bindings can share one physical press — Escape interrupts the
    // agent and closes the command center — and UIKit would take that as two
    // commands for the same key. Register the press once; the press comes back
    // as its combo string and the resolver picks the binding whose `when`
    // holds, exactly as it does for a web key event.
    const registrationKey = [
      command.input,
      command.namedKey,
      command.command,
      command.alternate,
      command.control,
      command.shift,
    ].join("|");
    if (registered.has(registrationKey)) {
      continue;
    }
    registered.add(registrationKey);
    commands.push(command);
  }
  return commands;
}

/**
 * Rebuilds the key event the web listener would have seen, so a native press
 * runs the same resolver, the same `when` conditions, and the same routing.
 */
export function keyboardShortcutInputFromCombo(combo: string): KeyboardShortcutInput | null {
  let parsedChord;
  try {
    parsedChord = parseBindingChord(combo);
  } catch {
    return null;
  }
  if (parsedChord.length !== 1) {
    return null;
  }
  const parsed = parsedChord[0];
  if (parsed.key === undefined && !NATIVE_NAMED_KEY_CODES.has(parsed.code)) {
    return null;
  }
  // A named key matches on `code` alone, but `key` is not optional on the input
  // and the DOM spells both the same way for every code in the set.
  return {
    key: parsed.key ?? parsed.code,
    code: parsed.code,
    altKey: parsed.alt === true,
    ctrlKey: parsed.ctrl === true,
    metaKey: parsed.meta === true || parsed.mod === true,
    shiftKey: parsed.shift === true,
    repeat: false,
  };
}
