/**
 * Process-wide configuration for the custom context menu.
 *
 * `ContextMenu.setTheme(...)` and `desktop.json`'s `contextMenu.theme` both end
 * in this store, so the host needs no provider and a secondary window picks the
 * same theme up. It is deliberately a tiny observable rather than React state:
 * the public entry point is a module object, not a component, and hosts in two
 * windows have to see one update.
 *
 * @format
 */

import type * as React from 'react';
import type { MenuRowProps } from './MenuRow';
import type { MenuSurfaceProps, MenuSeparatorProps } from './MenuSurface';
import type { MenuThemeSet } from './theme';

export type MenuPresentation = 'default' | 'custom' | 'native';

/**
 * The building blocks an app can replace.
 *
 * The host keeps placement, keyboard handling and dismissal, so a replacement
 * only draws: that is the line between "restyle the menu" and "write a menu",
 * and crossing it would mean every app reimplementing the behaviour the plan
 * spends most of section 5 on.
 */
export interface MenuRenderers {
  Row?: React.ComponentType<MenuRowProps>;
  Separator?: React.ComponentType<MenuSeparatorProps>;
  Surface?: React.ComponentType<MenuSurfaceProps>;
}

export interface ContextMenuConfig {
  theme?: MenuThemeSet;
  renderers?: MenuRenderers;
  /**
   * What `presentation: 'default'` resolves to.
   *
   * Set by `ContextMenu.setPresentation(...)` or `desktop.json`'s
   * `contextMenu.presentation` at startup. `'default'` here means "let the
   * platform decide", which is the OS menu on macOS and Windows and the
   * GPUI-drawn one on Linux.
   */
  presentation?: MenuPresentation;
}

let current: ContextMenuConfig = {};

const listeners = new Set<() => void>();

function emit(): void {
  // Copy first: a listener that unsubscribes while being notified must not
  // change the set being iterated.
  for (const listener of [...listeners]) {
    listener();
  }
}

export function subscribeContextMenuConfig(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The current configuration; the same object until a setter runs. */
export function contextMenuConfig(): ContextMenuConfig {
  return current;
}

export function setContextMenuConfig(next: ContextMenuConfig): void {
  current = { ...next };
  emit();
}

/**
 * `ContextMenu.setTheme({light, dark})` maps here. A field set to `undefined`
 * removes the override for that scheme, which is what a `setTheme({})` call
 * means.
 */
export function setContextMenuTheme(theme: MenuThemeSet): void {
  setContextMenuConfig({ ...current, theme: { ...theme } });
}

/** The configured overrides, for an integrator that wants to read them back. */
export function contextMenuTheme(): MenuThemeSet | undefined {
  return current.theme;
}

/**
 * `ContextMenu.setRenderers({Row, Separator, Surface})` maps here.
 *
 * Passing `undefined` for a slot restores the built-in for that slot only, so an
 * app can replace one piece without restating the others.
 */
export function setContextMenuRenderers(
  renderers: MenuRenderers | undefined,
): void {
  setContextMenuConfig({ ...current, renderers });
}

export function contextMenuRenderers(): MenuRenderers | undefined {
  return current.renderers;
}

/** The app-wide default for `presentation: 'default'`. */
export function setContextMenuPresentation(
  presentation: MenuPresentation | undefined,
): void {
  setContextMenuConfig({ ...current, presentation });
}

export function contextMenuPresentation(): MenuPresentation {
  return current.presentation ?? 'default';
}
