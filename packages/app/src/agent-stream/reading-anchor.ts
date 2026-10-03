interface RowGeometry {
  id: string;
  top: number;
  height: number;
}

// Store content coordinates, never a frozen viewport offset: user scrolling must
// survive a layout correction, including input delivered while a page is loading.
export function createReadingAnchor() {
  let anchor: { id: string; top: number } | null = null;
  return {
    getRowId: () => anchor?.id ?? null,
    reset() {
      anchor = null;
    },
    reconcile(scrollTop: number, rows: readonly RowGeometry[], userScrolled = false): number {
      const previous = anchor && rows.find((row) => row.id === anchor?.id);
      const correctedTop = scrollTop + (previous && anchor ? previous.top - anchor.top : 0);
      // A prepend can expose the bottom of an estimated row above the reader.
      // Do not transfer ownership to it until the user moves the reading position.
      const next =
        previous && !userScrolled
          ? previous
          : rows.find((row) => row.top + row.height > correctedTop + 8);
      anchor = next ? { id: next.id, top: next.top } : null;
      return correctedTop;
    },
  };
}
