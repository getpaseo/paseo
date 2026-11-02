/**
 * The registry that lets `ContextMenu.show` reach a window's open menu host.
 *
 * A host registers itself under its window id, and the public entry point looks
 * one up. Keeping the map and its helpers out of `ContextMenuHost.tsx` means the
 * lookup side can be imported by a module that never renders a component, and a
 * unit test can exercise the map without React.
 *
 * @format
 */

import type { Point } from './placement';
import type { MenuPresentation } from './config';
import type { MenuEntry } from './types';

export interface OpenCustomMenuOptions {
  items: MenuEntry[];
  /**
   * The anchor, in window coordinates. Without it the host uses the last pointer
   * position it saw, which is only known once a menu has been open; a caller
   * that has the trigger position should always pass it.
   */
  position?: Point;
  presentation?: MenuPresentation;
  /**
   * Called on close to return keyboard focus. The host cannot discover the
   * previously focused view: React Native exposes no query for it, and the
   * desktop TextInput has no `State`. A caller that knows its trigger can pass a
   * callback that focuses it again (for a view, `AccessibilityInfo.
   * setAccessibilityFocus(findNodeHandle(ref.current))`).
   */
  restoreFocus?: () => void;
  /**
   * Called instead of re-opening when the user right-clicks the backdrop, so a
   * caller that can hit-test the point can open the menu that belongs there.
   * Without it the host re-opens the same items at the new point, which is what
   * "right-clicking elsewhere moves the menu" means for a single menu.
   */
  onBackdropContextMenu?: (point: Point) => void;
}

export interface ContextMenuHandle {
  /** Open `items` in this window and resolve with the chosen id, or `null`. */
  open(options: OpenCustomMenuOptions): Promise<string | null>;
  /** Dismiss the open menu, resolving it with `null`. */
  close(): void;
}

const hosts = new Map<number, ContextMenuHandle>();

/**
 * Registers a host for `windowId` and returns an unregister function. A later
 * registration for the same window wins, because a reloaded tree can mount its
 * host before the old one unmounts.
 */
export function registerContextMenuHost(
  windowId: number,
  host: ContextMenuHandle,
): () => void {
  hosts.set(windowId, host);
  return () => {
    if (hosts.get(windowId) === host) {
      hosts.delete(windowId);
    }
  };
}

/** Removes `host` if it is still the registered one. */
export function unregisterContextMenuHost(
  windowId: number,
  host?: ContextMenuHandle,
): void {
  if (host == null || hosts.get(windowId) === host) {
    hosts.delete(windowId);
  }
}

/** The host for a window, or `null` when that window has none mounted yet. */
export function contextMenuHostFor(windowId: number): ContextMenuHandle | null {
  return hosts.get(windowId) ?? null;
}

export function hasContextMenuHost(windowId: number): boolean {
  return hosts.has(windowId);
}

/** Window ids that currently have a host, for diagnostics and tests. */
export function contextMenuWindowIds(): number[] {
  return [...hosts.keys()];
}
