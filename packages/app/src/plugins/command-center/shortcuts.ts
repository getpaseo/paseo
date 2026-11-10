import type { PluginCommandShortcut } from "@/keyboard/keyboard-shortcuts";

// Command Center contributions are rebuilt whenever the focused workspace, agent or plugin set
// changes, while the keydown listener needs one stable place to look. This store is that place:
// the Command Center registration publishes the current bindings, the listener subscribes.
type PluginCommandRunner = () => void | Promise<void>;

let shortcuts: readonly PluginCommandShortcut[] = [];
let runners = new Map<string, PluginCommandRunner>();
const listeners = new Set<() => void>();

export function setPluginCommandShortcuts(
  next: ReadonlyArray<PluginCommandShortcut & { run: PluginCommandRunner }>,
): void {
  const nextShortcuts = next.map(({ id, commandId, combo }) => ({ id, commandId, combo }));
  runners = new Map(next.map((entry) => [entry.commandId, entry.run]));
  if (sameShortcuts(shortcuts, nextShortcuts)) return;
  shortcuts = nextShortcuts;
  for (const listener of listeners) listener();
}

export const subscribeToPluginCommandShortcuts = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const getPluginCommandShortcuts = (): readonly PluginCommandShortcut[] => shortcuts;

/** No-op when the command is gone — a plugin can unload between keydown and dispatch. */
export function runPluginCommandShortcut(commandId: string): boolean {
  const run = runners.get(commandId);
  if (!run) return false;
  void run();
  return true;
}

function sameShortcuts(
  left: readonly PluginCommandShortcut[],
  right: readonly PluginCommandShortcut[],
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const other = right[index];
      return (
        entry.id === other.id && entry.commandId === other.commandId && entry.combo === other.combo
      );
    })
  );
}
