/**
 * The menu entry the React renderer works with.
 *
 * `MenuItemSpec` gives items and submenus an icon; the custom menu can also
 * draw one on a role row, so it is layered onto every kind here. The helper
 * type distributes over the spec's union, so narrowing on `type` still works.
 *
 * @format
 */

import type { ImageSourcePropType } from 'react-native';
import type { MenuItemSpec } from '../menu';

type WithIcon<T> = T extends unknown
  ? T & { icon?: ImageSourcePropType }
  : never;

export type MenuEntry = WithIcon<MenuItemSpec>;

export type MenuItemEntry = Extract<MenuEntry, { type?: 'item' }>;
export type MenuSubmenuEntry = Extract<MenuEntry, { type: 'submenu' }>;
export type MenuSeparatorEntry = Extract<MenuEntry, { type: 'separator' }>;
export type MenuRoleEntry = Extract<MenuEntry, { type: 'role' }>;

export type MenuEntryKind = 'item' | 'submenu' | 'separator' | 'role';

export function entryKind(entry: MenuEntry): MenuEntryKind {
  return entry.type ?? 'item';
}

export function isSeparator(entry: MenuEntry): entry is MenuSeparatorEntry {
  return entry.type === 'separator';
}

export function isSubmenu(entry: MenuEntry): entry is MenuSubmenuEntry {
  return entry.type === 'submenu';
}

export function isRole(entry: MenuEntry): entry is MenuRoleEntry {
  return entry.type === 'role';
}

export function isItem(entry: MenuEntry): entry is MenuItemEntry {
  return (
    entry.type !== 'separator' &&
    entry.type !== 'submenu' &&
    entry.type !== 'role'
  );
}

/**
 * Whether the row can be highlighted, chosen or opened. A separator is never
 * enabled, so callers do not have to check the kind first.
 */
export function isEnabled(entry: MenuEntry): boolean {
  if (isSeparator(entry)) {
    return false;
  }
  return entry.enabled !== false;
}

export function isChecked(entry: MenuEntry): boolean {
  return isItem(entry) && entry.checked === true;
}

export function submenuItems(entry: MenuEntry): MenuEntry[] | null {
  return isSubmenu(entry) ? (entry.items as MenuEntry[]) : null;
}

/** `selectAll` becomes "Select All", so a role item needs no label. */
export function humanizeRole(role: string): string {
  const spaced = role
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function entryLabel(entry: MenuEntry): string {
  if (isSeparator(entry)) {
    return '';
  }
  if (isRole(entry)) {
    return entry.label ?? humanizeRole(entry.role);
  }
  return entry.label;
}

/**
 * The value `open()` resolves with, or `null` for rows that never resolve on
 * their own. A submenu has no id of its own in the public type, so it uses one
 * when the caller supplied it; choosing a submenu row is not a selection.
 *
 * A role item resolves with its role name, so the integrator can run the same
 * action the native presenters run. That is the one deliberate difference from
 * a plain id, and it is documented on `ContextMenuHost`.
 */
export function entryId(entry: MenuEntry): string | null {
  if (isItem(entry)) {
    return entry.id;
  }
  if (isSubmenu(entry)) {
    return entry.id ?? null;
  }
  if (isRole(entry)) {
    return entry.role;
  }
  return null;
}

/** The test id suffix: an id when there is one, otherwise a stable label. */
export function entryTestId(entry: MenuEntry): string {
  return entryId(entry) ?? entryLabel(entry).toLowerCase().replace(/\s+/g, '-');
}

export function entryAccelerator(entry: MenuEntry): string | undefined {
  return isItem(entry) ? entry.accelerator : undefined;
}
