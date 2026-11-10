import { useState } from "react";
import type { ResolvedPluginButtonBehavior as PluginButtonBehavior } from "./validation";

/**
 * Menu open state for one rendered button. A behavior replacement, or a button that is hidden
 * or disabled, closes it. Republishing the same button object does not.
 */
export function usePluginButtonMenuOpen(button: {
  visible: boolean;
  disabled: boolean;
  behavior: PluginButtonBehavior;
}): readonly [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(false);
  const [behavior, setBehavior] = useState(button.behavior);
  const behaviorChanged = button.behavior !== behavior;
  const blocked = !button.visible || button.disabled;
  if (behaviorChanged) setBehavior(button.behavior);
  if (open && (behaviorChanged || blocked)) setOpen(false);
  return [behaviorChanged || blocked ? false : open, setOpen];
}
