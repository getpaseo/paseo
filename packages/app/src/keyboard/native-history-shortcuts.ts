import { buildEffectiveBindings, type ShortcutOverrides } from "./keyboard-shortcuts";
import type {
  KeyboardShortcutInput,
  ParsedShortcutBinding,
  ChordState,
} from "./keyboard-shortcuts";
import { parseShortcutString, SHORTCUT_KEY_NAMES, type KeyCombo } from "./shortcut-string";

export function buildNativeHistoryBindings(overrides: ShortcutOverrides) {
  return buildEffectiveBindings(overrides).filter((binding) =>
    binding.action.startsWith("navigation.history."),
  );
}

function commandForCombo(combo: KeyCombo): KeyboardShortcutInput {
  return {
    key: combo.key ?? combo.code,
    code: combo.code,
    ctrlKey: combo.ctrl === true,
    metaKey: combo.meta === true || combo.mod === true,
    altKey: combo.alt === true,
    shiftKey: combo.shift === true,
    repeat: false,
  };
}

export function buildNativeHistoryCommands(
  bindings: readonly ParsedShortcutBinding[],
  chord: Pick<ChordState, "candidateIndices" | "step">,
): KeyboardShortcutInput[] {
  const activeBindings =
    chord.step > 0 ? chord.candidateIndices.map((index) => bindings[index]) : bindings;
  return activeBindings.flatMap((binding) => {
    const combo = binding.parsedChord[chord.step];
    return combo ? [commandForCombo(combo)] : [];
  });
}

export function buildNativeShortcutCaptureCommands(): KeyboardShortcutInput[] {
  const commands: KeyboardShortcutInput[] = [];
  for (const key of SHORTCUT_KEY_NAMES) {
    if (key === "Digit") continue;
    const command = commandForCombo(parseShortcutString(key));
    for (let modifiers = 0; modifiers < 16; modifiers++) {
      commands.push({
        ...command,
        ctrlKey: Boolean(modifiers & 1),
        altKey: Boolean(modifiers & 2),
        metaKey: Boolean(modifiers & 4),
        shiftKey: Boolean(modifiers & 8),
      });
    }
  }
  return commands;
}
