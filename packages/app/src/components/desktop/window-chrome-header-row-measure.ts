/** One child of a header row, as measured from the layout it is rendered in. */
export interface HeaderRowChildBox {
  /** Absolute children are out of flow; they never push the row's trailing content. */
  isAbsolute: boolean;
  /** A child that can shrink yields its width rather than colliding with anything. */
  canShrink: boolean;
  /** The width the child wants, independent of the width the row gave it. */
  intrinsicWidth: number;
}

/**
 * How much width a header row needs before the native window controls start clipping it.
 *
 * Only rigid children count. A leading title grows to fill the row and truncates when squeezed,
 * so its intrinsic width says nothing about whether the row fits -- counting it reports every
 * row as full and drops headers that had hundreds of spare pixels. Absolute children are out of
 * flow and never push anything.
 */
export function resolveHeaderRowContentWidth(input: {
  children: readonly HeaderRowChildBox[];
  /** Gap the row puts between adjacent children. */
  gap: number;
  /** Padding the row keeps on each side regardless of window chrome. */
  horizontalPadding: number;
}): number {
  const rigid = input.children.filter((child) => !child.isAbsolute && !child.canShrink);
  const contentWidth = rigid.reduce((total, child) => total + child.intrinsicWidth, 0);
  const gaps = Math.max(rigid.length - 1, 0) * input.gap;
  return contentWidth + gaps + input.horizontalPadding * 2;
}
