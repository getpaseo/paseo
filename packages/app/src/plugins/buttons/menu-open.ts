import { useState } from "react";

export interface PluginButtonMenuOpenState {
  open: boolean;
  revision: number;
  nextRevision: number;
  visible: boolean;
  disabled: boolean;
}

/**
 * Whether one rendered plugin button menu stays open.
 *
 * `validateButton` returns a new behavior object on every update, including a label change or
 * locale refresh. Those keep the same revision. The revision changes only when the plugin sets
 * behavior, and that closes the menu. A hidden or disabled button closes it too.
 */
export function pluginButtonMenuOpen(state: PluginButtonMenuOpenState): boolean {
  const revisionChanged = state.nextRevision !== state.revision;
  const blocked = !state.visible || state.disabled;
  return state.open && !revisionChanged && !blocked;
}

/** Menu open state for one rendered copy. Copies do not share the store's `open` flag. */
export function usePluginButtonMenuOpen(button: {
  visible: boolean;
  disabled: boolean;
  behaviorRevision: number;
}): readonly [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(false);
  const [revision, setRevision] = useState(button.behaviorRevision);
  const nextOpen = pluginButtonMenuOpen({
    open,
    revision,
    nextRevision: button.behaviorRevision,
    visible: button.visible,
    disabled: button.disabled,
  });
  if (revision !== button.behaviorRevision) setRevision(button.behaviorRevision);
  if (open && !nextOpen) setOpen(false);
  return [nextOpen, setOpen];
}
