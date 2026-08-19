/**
 * The menu engine.
 *
 * One state model and one item vocabulary behind two presentations — an anchored popover on
 * wide screens, a bottom sheet on compact ones — and two trigger shapes, which live in the
 * `dropdown-menu` and `context-menu` wrappers.
 *
 * See docs/menus.md.
 */

export { MenuRoot, MenuTrigger, type MenuTriggerProps, type MenuTriggerState } from "./menu-root";
export {
  MenuSurface,
  useMenuSurface,
  type MenuPageDefinition,
  type MenuSurfaceProps,
} from "./menu-surface";
export { MenuSubTrigger } from "./menu-sub";
export {
  MenuHint,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTextField,
  menuRowContentInset,
  type ActionStatus,
  type MenuItemProps,
} from "./menu-item";
export {
  useMenuContext,
  useMenuDepth,
  type MenuCompactMode,
  type MenuContextValue,
  type MenuPresentation,
} from "./menu-context";
export { currentPageId, isSubPageOpen, MENU_ROOT_PATH, type MenuPath } from "./menu-navigation";
export type { Alignment, Placement, Rect, Size } from "./menu-anchor";
