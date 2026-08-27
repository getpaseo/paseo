import {
  parseBindingChord,
  type KeyboardShortcutInput,
  type ParsedShortcutBinding,
} from "@/keyboard/keyboard-shortcuts";

/**
 * Binding ids handed to iOS as `UIKeyCommand`s.
 *
 * A registered key command is consumed before the focused surface sees it, so
 * anything the terminal needs stays off this list. Escape is the notable
 * absence: it would interrupt the agent, but it would also swallow the Escape
 * that vim inside a terminal tab is waiting for, and native has no focus-scope
 * signal to tell the two apart.
 */
export const NATIVE_HARDWARE_SHORTCUT_BINDING_IDS: readonly string[] = [
  "workspace-new-cmd-n-mac",
  "sidebar-toggle-left-mac-cmd-b",
  "command-center-toggle-cmd-k-mac",
  "workspace-project-pick-cmd-p-mac",
  "agent-new-cmd-shift-o-mac",
  "message-input-focus-cmd-l-mac",
  "settings-toggle-cmd-comma-mac",
];

export interface NativeKeyCommand {
  combo: string;
  input: string;
  command: boolean;
  alternate: boolean;
  control: boolean;
  shift: boolean;
}

/**
 * `UIKeyCommand` takes one character and a modifier mask, so a binding only
 * makes it across if it is a single combo whose key is a literal character.
 * Chords, `Digit` wildcards, and named keys such as Backspace are dropped.
 */
export function buildNativeKeyCommands(
  bindings: readonly ParsedShortcutBinding[],
): NativeKeyCommand[] {
  const commands: NativeKeyCommand[] = [];
  for (const bindingId of NATIVE_HARDWARE_SHORTCUT_BINDING_IDS) {
    const binding = bindings.find((candidate) => candidate.id === bindingId);
    if (!binding || binding.parsedChord.length !== 1) {
      continue;
    }
    const combo = binding.parsedChord[0];
    if (combo.key === undefined) {
      continue;
    }
    commands.push({
      combo: binding.combo,
      input: combo.key,
      command: combo.meta === true || combo.mod === true,
      alternate: combo.alt === true,
      control: combo.ctrl === true,
      shift: combo.shift === true,
    });
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
  if (parsed.key === undefined) {
    return null;
  }
  return {
    key: parsed.key,
    code: parsed.code,
    altKey: parsed.alt === true,
    ctrlKey: parsed.ctrl === true,
    metaKey: parsed.meta === true || parsed.mod === true,
    shiftKey: parsed.shift === true,
    repeat: false,
  };
}
