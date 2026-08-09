import { useMemo, useState } from "react";

/**
 * Keeps a row's kebab in its slot for as long as the menu it opened is up.
 *
 * The kebab is revealed by hover, and the surface it opens can take the pointer off the row —
 * on a compact layout the sheet slides up over it. The row then reads as un-hovered, the
 * trailing overlay unmounts its own trigger mid-gesture, and the open menu is left with no
 * state that can close it: on a sheet that strands a full-screen backdrop over the app until
 * reload. Lifting the menu's open state to the component that decides whether to render it is
 * what stops the row from pulling the ground out from under it.
 */
export function useOpenKebabMenuVisibility(showKebab: boolean): {
  showKebab: boolean;
  menuProps: { open: boolean; onOpenChange: (open: boolean) => void };
} {
  const [open, setOpen] = useState(false);
  const menuProps = useMemo(() => ({ open, onOpenChange: setOpen }), [open]);
  return { showKebab: showKebab || open, menuProps };
}
