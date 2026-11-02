/**
 * Where every open menu level goes, in window coordinates.
 *
 * Each level is measured on its own, but its position depends on the levels
 * above it: a submenu is placed against its parent's row, so the chain has to be
 * resolved top-down, using the *parent's* placement rather than the root's. That
 * chaining is the part a three-level menu depends on, so it is kept here as one
 * pure function over plain data instead of inside the host, where it could only
 * be tested through React.
 *
 * @format
 */

import type { MenuEntry } from './types';
import {
  placeRootMenu,
  placeSubmenu,
  type Point,
  type Rect,
  type Size,
  type SubmenuSide,
} from './placement';

/** One measured row, relative to the panel that contains it. */
export interface RowBox {
  y: number;
  height: number;
}

/** One open level of the menu, from the root down to the deepest submenu. */
export interface MenuLevel {
  items: MenuEntry[];
  highlightedIndex: number;
  /** The level's measured size, or `null` until `onLayout` has reported it. */
  size: Size | null;
  /** Row boxes relative to the panel, filled in by each row's `onLayout`. */
  rows: Record<number, RowBox>;
  /** The row of the parent level that opened this one. Zero for the root. */
  parentIndex: number;
  /** The pointer position when this level opened, for the safe triangle. */
  openedAt: Point | null;
}

/** Where a level was placed, and which side a submenu opened on. */
export interface Placement {
  point: Point;
  /**
   * `null` for the root, which is not beside anything; a submenu reports the
   * side it opened on so the safe triangle can use the near edge.
   */
  side: SubmenuSide | null;
}

/**
 * A row's rectangle in window coordinates.
 *
 * The rows are measured relative to their panel, so the panel's own placement is
 * what turns them into the window space `placeSubmenu` works in. Returns `null`
 * when either measurement is still missing: a level cannot be placed against a
 * row whose height nobody has reported.
 */
export function rowRect(
  level: MenuLevel,
  panel: Point,
  index: number,
): Rect | null {
  const row = level.rows[index];
  if (row == null || level.size == null) {
    return null;
  }
  return {
    x: panel.x,
    y: panel.y + row.y,
    width: level.size.width,
    height: row.height,
  };
}

/**
 * The placement of every level, or `null` for one that cannot be placed yet.
 *
 * The root goes at the anchor through `placeRootMenu`. Every other level goes
 * beside the row that opened it, resolved against the placement of the level
 * directly above it, which is what makes the third level sit against the second
 * rather than against the root. A missing measurement does not throw and does
 * not fall back to a guess: it yields `null`, and every level below it also gets
 * `null`, because its parent has no position to attach to. The host draws those
 * levels at zero opacity, which is its measuring pass.
 */
export function placeLevels(
  levels: MenuLevel[],
  anchor: Point | null | undefined,
  windowSize: Size | null | undefined,
): Array<Placement | null> {
  if (anchor == null || windowSize == null) {
    return levels.map(() => null);
  }
  const result: Array<Placement | null> = [];
  levels.forEach((level, index) => {
    if (level.size == null) {
      result.push(null);
      return;
    }
    if (index === 0) {
      result.push({
        point: placeRootMenu({ anchor, menuSize: level.size, windowSize }),
        side: null,
      });
      return;
    }
    const parent = levels[index - 1];
    const parentPlacement = result[index - 1];
    const rect =
      parentPlacement == null
        ? null
        : rowRect(parent, parentPlacement.point, level.parentIndex);
    if (rect == null) {
      result.push(null);
      return;
    }
    const placed = placeSubmenu({
      rowRect: rect,
      menuSize: level.size,
      windowSize,
    });
    // `placeSubmenu` reports the side alongside the point because the safe
    // triangle needs it; the placement keeps the two apart, so `point` stays a
    // plain coordinate that can be spread into a style or used as a rect origin.
    result.push({ point: { x: placed.x, y: placed.y }, side: placed.side });
  });
  return result;
}
