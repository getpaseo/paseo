export interface DiffViewportWindow {
  viewportTop: number;
  viewportHeight: number;
  overscan: number;
}

export interface DiffRowWindow {
  startIndex: number;
  endIndex: number;
  beforeHeight: number;
  renderedHeight: number;
  afterHeight: number;
  totalHeight: number;
}

export interface DiffViewportSnapshot {
  top: number;
  height: number;
}

export interface DiffViewport {
  getSnapshot: () => DiffViewportSnapshot;
  subscribe: (listener: () => void) => () => void;
  update: (snapshot: DiffViewportSnapshot) => void;
  dispose: () => void;
}

/** Coalesce native/web scroll events so diff bodies select rows at most once per frame. */
export function createDiffViewport(): DiffViewport {
  let snapshot: DiffViewportSnapshot = { top: 0, height: 0 };
  let pending = snapshot;
  let frame: number | null = null;
  const listeners = new Set<() => void>();

  const flush = () => {
    frame = null;
    if (pending.top === snapshot.top && pending.height === snapshot.height) {
      return;
    }
    snapshot = pending;
    for (const listener of listeners) {
      listener();
    }
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update(nextSnapshot) {
      pending = nextSnapshot;
      frame ??= requestAnimationFrame(flush);
    },
    dispose() {
      if (frame !== null) {
        cancelAnimationFrame(frame);
      }
      frame = null;
      listeners.clear();
    },
  };
}

/**
 * Select the contiguous diff rows that intersect a viewport while reserving
 * exact spacer heights for everything outside it.
 */
export function createDiffRowWindow(
  rowHeights: readonly number[],
  viewport: DiffViewportWindow,
): DiffRowWindow {
  const offsets = Array.from({ length: rowHeights.length + 1 }, () => 0);
  offsets[0] = 0;
  for (let index = 0; index < rowHeights.length; index += 1) {
    offsets[index + 1] = offsets[index] + rowHeights[index];
  }

  const totalHeight = offsets[rowHeights.length];
  const visibleTop = viewport.viewportTop - viewport.overscan;
  const visibleBottom = viewport.viewportTop + viewport.viewportHeight + viewport.overscan;

  if (visibleBottom <= 0) {
    return emptyWindow(0, 0, totalHeight);
  }
  if (visibleTop >= totalHeight) {
    return emptyWindow(rowHeights.length, totalHeight, 0);
  }

  const startIndex = firstIndexWhoseEndExceeds(offsets, Math.max(0, visibleTop));
  const endIndex = firstIndexWhoseStartReaches(offsets, Math.min(totalHeight, visibleBottom));
  const beforeHeight = offsets[startIndex];
  const renderedHeight = offsets[endIndex] - beforeHeight;

  return {
    startIndex,
    endIndex,
    beforeHeight,
    renderedHeight,
    afterHeight: totalHeight - offsets[endIndex],
    totalHeight,
  };
}

function emptyWindow(index: number, beforeHeight: number, afterHeight: number): DiffRowWindow {
  return {
    startIndex: index,
    endIndex: index,
    beforeHeight,
    renderedHeight: 0,
    afterHeight,
    totalHeight: beforeHeight + afterHeight,
  };
}

function firstIndexWhoseEndExceeds(offsets: readonly number[], target: number): number {
  let low = 1;
  let high = offsets.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((offsets[middle] ?? Number.POSITIVE_INFINITY) > target) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  return Math.min(offsets.length - 1, low - 1);
}

function firstIndexWhoseStartReaches(offsets: readonly number[], target: number): number {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (offsets[middle] >= target) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  return low;
}
