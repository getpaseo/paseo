import type { SplitNode } from "@/stores/workspace-layout-store";

const ROOT_MIN = 0;
const ROOT_MAX = 1;
const FLOAT_TOLERANCE = 0.000001;

export interface PaneBounds {
  paneId: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
  centerX: number;
  centerY: number;
}

interface PaneCandidate {
  paneId: string;
  primaryDistance: number;
  secondaryDistance: number;
  centerDistance: number;
  overlap: number;
}

export function findAdjacentPane(
  root: SplitNode,
  focusedPaneId: string,
  direction: "left" | "right" | "up" | "down",
): string | null {
  const panes = collectPaneBounds(root, {
    left: ROOT_MIN,
    top: ROOT_MIN,
    right: ROOT_MAX,
    bottom: ROOT_MAX,
  });
  const focusedPane = panes.find((pane) => pane.paneId === focusedPaneId) ?? null;
  if (!focusedPane) {
    return null;
  }

  const candidates = panes
    .filter((pane) => pane.paneId !== focusedPaneId)
    .map((pane) => buildCandidate({ pane, focusedPane, direction }))
    .filter((candidate): candidate is PaneCandidate => candidate !== null)
    .sort(compareCandidates);

  return candidates[0]?.paneId ?? null;
}

function compareCandidates(left: PaneCandidate, right: PaneCandidate): number {
  if (left.primaryDistance !== right.primaryDistance) {
    return left.primaryDistance - right.primaryDistance;
  }
  if (left.secondaryDistance !== right.secondaryDistance) {
    return left.secondaryDistance - right.secondaryDistance;
  }
  if (left.overlap !== right.overlap) {
    return right.overlap - left.overlap;
  }
  if (left.centerDistance !== right.centerDistance) {
    return left.centerDistance - right.centerDistance;
  }
  return left.paneId.localeCompare(right.paneId);
}

function buildCandidate(input: {
  pane: PaneBounds;
  focusedPane: PaneBounds;
  direction: "left" | "right" | "up" | "down";
}): PaneCandidate | null {
  const { pane, focusedPane, direction } = input;
  if (direction === "left") {
    const primaryDistance = focusedPane.left - pane.right;
    if (primaryDistance < -FLOAT_TOLERANCE) {
      return null;
    }
    const overlap = getOverlapLength({
      startA: pane.top,
      endA: pane.bottom,
      startB: focusedPane.top,
      endB: focusedPane.bottom,
    });
    return {
      paneId: pane.paneId,
      primaryDistance,
      secondaryDistance: getGapLength({
        startA: pane.top,
        endA: pane.bottom,
        startB: focusedPane.top,
        endB: focusedPane.bottom,
      }),
      centerDistance: Math.abs(pane.centerY - focusedPane.centerY),
      overlap,
    };
  }
  if (direction === "right") {
    const primaryDistance = pane.left - focusedPane.right;
    if (primaryDistance < -FLOAT_TOLERANCE) {
      return null;
    }
    const overlap = getOverlapLength({
      startA: pane.top,
      endA: pane.bottom,
      startB: focusedPane.top,
      endB: focusedPane.bottom,
    });
    return {
      paneId: pane.paneId,
      primaryDistance,
      secondaryDistance: getGapLength({
        startA: pane.top,
        endA: pane.bottom,
        startB: focusedPane.top,
        endB: focusedPane.bottom,
      }),
      centerDistance: Math.abs(pane.centerY - focusedPane.centerY),
      overlap,
    };
  }
  if (direction === "up") {
    const primaryDistance = focusedPane.top - pane.bottom;
    if (primaryDistance < -FLOAT_TOLERANCE) {
      return null;
    }
    const overlap = getOverlapLength({
      startA: pane.left,
      endA: pane.right,
      startB: focusedPane.left,
      endB: focusedPane.right,
    });
    return {
      paneId: pane.paneId,
      primaryDistance,
      secondaryDistance: getGapLength({
        startA: pane.left,
        endA: pane.right,
        startB: focusedPane.left,
        endB: focusedPane.right,
      }),
      centerDistance: Math.abs(pane.centerX - focusedPane.centerX),
      overlap,
    };
  }

  const primaryDistance = pane.top - focusedPane.bottom;
  if (primaryDistance < -FLOAT_TOLERANCE) {
    return null;
  }
  const overlap = getOverlapLength({
    startA: pane.left,
    endA: pane.right,
    startB: focusedPane.left,
    endB: focusedPane.right,
  });
  return {
    paneId: pane.paneId,
    primaryDistance,
    secondaryDistance: getGapLength({
      startA: pane.left,
      endA: pane.right,
      startB: focusedPane.left,
      endB: focusedPane.right,
    }),
    centerDistance: Math.abs(pane.centerX - focusedPane.centerX),
    overlap,
  };
}

function collectPaneBounds(
  node: SplitNode,
  bounds: { left: number; top: number; right: number; bottom: number },
): PaneBounds[] {
  if (node.kind === "pane") {
    if (node.pane.hidden === true) {
      return [];
    }
    return [
      {
        paneId: node.pane.id,
        left: bounds.left,
        top: bounds.top,
        right: bounds.right,
        bottom: bounds.bottom,
        centerX: (bounds.left + bounds.right) / 2,
        centerY: (bounds.top + bounds.bottom) / 2,
      },
    ];
  }

  const panes: PaneBounds[] = [];
  const totalWidth = bounds.right - bounds.left;
  const totalHeight = bounds.bottom - bounds.top;
  let offset = 0;

  for (let index = 0; index < node.group.children.length; index += 1) {
    const child = node.group.children[index];
    const size = node.group.sizes[index] ?? 0;

    if (node.group.direction === "horizontal") {
      const childLeft = bounds.left + totalWidth * offset;
      offset += size;
      const childRight = bounds.left + totalWidth * offset;
      panes.push(
        ...collectPaneBounds(child, {
          left: childLeft,
          top: bounds.top,
          right: childRight,
          bottom: bounds.bottom,
        }),
      );
      continue;
    }

    const childTop = bounds.top + totalHeight * offset;
    offset += size;
    const childBottom = bounds.top + totalHeight * offset;
    panes.push(
      ...collectPaneBounds(child, {
        left: bounds.left,
        top: childTop,
        right: bounds.right,
        bottom: childBottom,
      }),
    );
  }

  return panes;
}

function getGapLength(input: {
  startA: number;
  endA: number;
  startB: number;
  endB: number;
}): number {
  const { startA, endA, startB, endB } = input;
  if (endA < startB) {
    return startB - endA;
  }
  if (endB < startA) {
    return startA - endB;
  }
  return 0;
}

function getOverlapLength(input: {
  startA: number;
  endA: number;
  startB: number;
  endB: number;
}): number {
  const { startA, endA, startB, endB } = input;
  return Math.max(0, Math.min(endA, endB) - Math.max(startA, startB));
}
