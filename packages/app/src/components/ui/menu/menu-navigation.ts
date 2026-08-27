/**
 * Which submenu pages are open, as a path from the root outward.
 *
 * The desktop flyout chain and the mobile push stack are the same structure, which is why
 * there is one model and not two: a pointer surface renders *every* page in the path as its
 * own anchored surface, and a compact sheet renders only the last one. Nothing else differs.
 *
 * Pure and React-free on purpose — the ordering rules below are the part worth testing, and
 * they don't need a renderer to exercise.
 */

/** Sub-page ids from the root outward. Empty means the root page is showing. */
export type MenuPath = readonly string[];

export const MENU_ROOT_PATH: MenuPath = [];

/**
 * Opening a submenu truncates the path to the depth of the trigger that opened it, so moving
 * between two triggers on the same page swaps branches instead of nesting them. Without this,
 * sliding the pointer across a menu would stack up every flyout it passed.
 *
 * `depth` is how many sub-pages sit above the trigger's own page: a trigger on the root page
 * is depth 0, one inside a first-level submenu is depth 1.
 */
export function openSubPage(path: MenuPath, sub: { id: string; depth: number }): MenuPath {
  if (isSubPageOpen(path, sub)) return path;
  return [...path.slice(0, sub.depth), sub.id];
}

/** Closes the page opened at `depth` and everything it opened in turn. */
export function closeSubPage(path: MenuPath, depth: number): MenuPath {
  if (path.length <= depth) return path;
  return path.slice(0, depth);
}

export function goBack(path: MenuPath): MenuPath {
  if (path.length === 0) return path;
  return path.slice(0, -1);
}

/** The page a compact surface should render. Null means the root page. */
export function currentPageId(path: MenuPath): string | null {
  return path.length === 0 ? null : (path[path.length - 1] ?? null);
}

export function isSubPageOpen(path: MenuPath, sub: { id: string; depth: number }): boolean {
  return path[sub.depth] === sub.id;
}
