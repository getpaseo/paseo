import { useCallback, type ReactElement } from "react";
import {
  MenuHint,
  MenuItem,
  MenuLabel,
  MenuRoot,
  MenuSeparator,
  MenuSurface,
  MenuTrigger,
  useMenuContext,
  type MenuSurfaceProps,
  type MenuTriggerProps,
} from "@/components/ui/menu";

/**
 * A menu opened by pressing its trigger.
 *
 * Everything below the trigger is the shared menu engine — see `@/components/ui/menu` and
 * docs/menus.md. This file is the press-to-open shape and the `DropdownMenu*` names the app
 * already uses; `context-menu.tsx` is the same engine behind a long press.
 */

export { MenuRoot as DropdownMenu };
export { MenuTrigger as DropdownMenuTrigger };
export { MenuItem as DropdownMenuItem };
export { MenuLabel as DropdownMenuLabel };
export { MenuSeparator as DropdownMenuSeparator };
export { MenuHint as DropdownMenuHint };
export type { MenuTriggerProps as DropdownMenuTriggerProps };
export type { ActionStatus, MenuItemProps as DropdownMenuItemProps } from "@/components/ui/menu";
export type { MenuPageDefinition } from "@/components/ui/menu";
export { MenuSubTrigger as DropdownMenuSubTrigger } from "@/components/ui/menu";

export function DropdownMenuContent(props: MenuSurfaceProps): ReactElement | null {
  return <MenuSurface {...props} />;
}

export function useDropdownMenuClose(): () => void {
  const { setOpen } = useMenuContext("useDropdownMenuClose");
  return useCallback(() => setOpen(false), [setOpen]);
}
