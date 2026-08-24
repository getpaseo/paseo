import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { Platform, type View } from "react-native";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useDismissKeyboardOnOpen } from "@/components/ui/keyboard-dismiss";
import {
  closeSubPage,
  goBack as goBackPath,
  MENU_ROOT_PATH,
  openSubPage,
  type MenuPath,
} from "./menu-navigation";
import type { Rect } from "./menu-anchor";

/**
 * How a menu draws itself once it is open.
 *
 * `popover` anchors a floating surface to the trigger and opens submenus as flyouts beside it.
 * `sheet` presents from the bottom edge and opens submenus by replacing the page in place.
 * The choice is made from form factor, not platform, so a tablet in a narrow split view sheets
 * the same way a phone does.
 */
export type MenuPresentation = "popover" | "sheet";

/** What a menu does on a compact screen. Wide screens are always a popover. */
export type MenuCompactMode = "popover" | "sheet";

/** How long UIKit is given to finish removing the menu surface before an action runs. */
export const IOS_TEARDOWN_GRACE_MS = 250;

export interface MenuContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  /** Runs an item's action, closing the menu first when the item asks for it. */
  selectItem: (onSelect: (() => void) | undefined, closeOnSelect: boolean) => void;
  triggerRef: React.RefObject<View | null>;
  /** Point anchor for menus opened from a gesture rather than a trigger box. */
  anchorRect: Rect | null;
  setAnchorRect: (rect: Rect | null) => void;
  presentation: MenuPresentation;
  path: MenuPath;
  openSub: (sub: { id: string; depth: number }) => void;
  closeSub: (depth: number) => void;
  goBack: () => void;
}

const MenuContext = createContext<MenuContextValue | null>(null);

export const MenuContextProvider = MenuContext.Provider;

export function useMenuContext(componentName: string): MenuContextValue {
  const ctx = useContext(MenuContext);
  if (!ctx) {
    throw new Error(`${componentName} must be used within a menu root`);
  }
  return ctx;
}

/**
 * How many submenu pages sit above the component reading it. A trigger on the root page is
 * depth 0. Each open submenu re-provides this one higher, which is what lets a submenu trigger
 * know whether it should nest below the current page or replace a sibling branch.
 */
const MenuDepthContext = createContext(0);

export const MenuDepthProvider = MenuDepthContext.Provider;

export function useMenuDepth(): number {
  return useContext(MenuDepthContext);
}

function useControllableOpenState({
  open,
  defaultOpen,
  onOpenChange,
}: {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}): [boolean, (next: boolean) => void] {
  const [internalOpen, setInternalOpen] = useState(Boolean(defaultOpen));
  const isControlled = typeof open === "boolean";
  const value = isControlled ? open : internalOpen;
  const setValue = useCallback(
    (next: boolean) => {
      if (!isControlled) setInternalOpen(next);
      onOpenChange?.(next);
    },
    [isControlled, onOpenChange],
  );
  return [value, setValue];
}

/**
 * Everything one menu knows about itself. Both menu shapes build on this; they differ only in
 * what opens them, which is why the trigger is the wrapper's job and nothing here.
 */
export function useMenuState({
  open,
  defaultOpen,
  onOpenChange,
  compactMode = "popover",
}: {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  compactMode?: MenuCompactMode;
}): MenuContextValue {
  const triggerRef = useRef<View>(null);
  const [anchorRect, setAnchorRect] = useState<Rect | null>(null);
  const [path, setPath] = useState<MenuPath>(MENU_ROOT_PATH);
  const isCompact = useIsCompactFormFactor();
  const presentation: MenuPresentation = isCompact && compactMode === "sheet" ? "sheet" : "popover";

  const [isOpen, setIsOpenState] = useControllableOpenState({ open, defaultOpen, onOpenChange });
  useDismissKeyboardOnOpen(isOpen);

  // A menu always reopens on its root page, against a freshly measured anchor. Keeping either
  // would reopen the surface three levels deep, or at the coordinates of the last right click.
  const setOpen = useCallback(
    (next: boolean) => {
      if (!next) {
        setPath(MENU_ROOT_PATH);
        setAnchorRect(null);
      }
      setIsOpenState(next);
    },
    [setIsOpenState],
  );

  const selectItem = useCallback(
    (onSelect: (() => void) | undefined, closeOnSelect: boolean) => {
      if (!closeOnSelect) {
        onSelect?.();
        return;
      }

      setOpen(false);
      if (!onSelect) return;

      if (Platform.OS === "ios") {
        // Native presenters such as PHPicker can hang if launched while UIKit is still
        // tearing down the surface this menu was drawn in. The wait is timed rather than
        // driven by the surface's own dismissal callback: both surfaces unmount as soon as
        // the menu closes, so any such callback is racing its own removal and usually loses.
        setTimeout(onSelect, IOS_TEARDOWN_GRACE_MS);
        return;
      }

      onSelect();
    },
    [setOpen],
  );

  const openSub = useCallback((sub: { id: string; depth: number }) => {
    setPath((current) => openSubPage(current, sub));
  }, []);

  const closeSub = useCallback((depth: number) => {
    setPath((current) => closeSubPage(current, depth));
  }, []);

  const goBack = useCallback(() => {
    setPath((current) => goBackPath(current));
  }, []);

  return useMemo(
    () => ({
      open: isOpen,
      setOpen,
      selectItem,
      triggerRef,
      anchorRect,
      setAnchorRect,
      presentation,
      path,
      openSub,
      closeSub,
      goBack,
    }),
    [isOpen, setOpen, selectItem, anchorRect, presentation, path, openSub, closeSub, goBack],
  );
}
