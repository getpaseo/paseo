import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dimensions, Platform, StatusBar, type View } from "react-native";

export type Placement = "top" | "bottom" | "left" | "right";
export type Alignment = "start" | "center" | "end";

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface FloatingStyles {
  position: "absolute";
  top: number;
  left: number;
}

interface GeometryResult {
  popoverOrigin: { x: number; y: number };
  placement: Placement;
  availableSize: { width: number; height: number };
}

function measureElement(element: View): Promise<Rect> {
  return new Promise((resolve) => {
    element.measureInWindow((x, y, width, height) => {
      resolve({ x, y, width, height });
    });
  });
}

function computeGeometry({
  fromRect,
  contentSize,
  displayArea,
  placement,
  alignment,
  offset,
  padding,
}: {
  fromRect: Rect;
  contentSize: { width: number; height: number };
  displayArea: Rect;
  placement: Placement;
  alignment: Alignment;
  offset: number;
  padding: number;
}): GeometryResult {
  const { width: contentWidth, height: contentHeight } = contentSize;

  // Calculate available space in each direction
  const spaceTop = fromRect.y - displayArea.y - padding;
  const spaceBottom = displayArea.y + displayArea.height - (fromRect.y + fromRect.height) - padding;
  const spaceLeft = fromRect.x - displayArea.x - padding;
  const spaceRight = displayArea.x + displayArea.width - (fromRect.x + fromRect.width) - padding;

  // Determine actual placement (may flip if not enough space)
  let actualPlacement = placement;
  if (placement === "bottom" && spaceBottom < contentHeight && spaceTop > spaceBottom) {
    actualPlacement = "top";
  } else if (placement === "top" && spaceTop < contentHeight && spaceBottom > spaceTop) {
    actualPlacement = "bottom";
  } else if (placement === "left" && spaceLeft < contentWidth && spaceRight > spaceLeft) {
    actualPlacement = "right";
  } else if (placement === "right" && spaceRight < contentWidth && spaceLeft > spaceRight) {
    actualPlacement = "left";
  }

  let x: number;
  let y: number;

  // Position based on placement
  if (actualPlacement === "bottom") {
    y = fromRect.y + fromRect.height + offset;
  } else if (actualPlacement === "top") {
    y = fromRect.y - contentHeight - offset;
  } else if (actualPlacement === "left") {
    x = fromRect.x - contentWidth - offset;
  } else {
    x = fromRect.x + fromRect.width + offset;
  }

  // Alignment on cross axis
  if (actualPlacement === "top" || actualPlacement === "bottom") {
    if (alignment === "start") {
      x = fromRect.x;
    } else if (alignment === "end") {
      x = fromRect.x + fromRect.width - contentWidth;
    } else {
      x = fromRect.x + (fromRect.width - contentWidth) / 2;
    }
  } else {
    if (alignment === "start") {
      y = fromRect.y;
    } else if (alignment === "end") {
      y = fromRect.y + fromRect.height - contentHeight;
    } else {
      y = fromRect.y + (fromRect.height - contentHeight) / 2;
    }
  }

  // Constrain to display area (shift)
  const minX = displayArea.x + padding;
  const maxX = displayArea.x + displayArea.width - contentWidth - padding;
  const minY = displayArea.y + padding;
  const maxY = displayArea.y + displayArea.height - contentHeight - padding;

  x = Math.max(minX, Math.min(maxX, x!));
  y = Math.max(minY, Math.min(maxY, y!));

  // Calculate available size
  const availableWidth = displayArea.width - padding * 2;
  const availableHeight =
    actualPlacement === "bottom"
      ? displayArea.y + displayArea.height - (fromRect.y + fromRect.height) - offset - padding
      : actualPlacement === "top"
        ? fromRect.y - displayArea.y - offset - padding
        : displayArea.height - padding * 2;

  return {
    popoverOrigin: { x, y },
    placement: actualPlacement,
    availableSize: {
      width: Math.max(0, availableWidth),
      height: Math.max(0, availableHeight),
    },
  };
}

export interface UseDropdownFloatingOptions {
  open: boolean;
  placement?: Placement;
  alignment?: Alignment;
  offset?: number;
  padding?: number;
  referenceEl: View | null;
}

export interface UseDropdownFloatingReturn {
  floatingRef: (el: View | null) => void;
  floatingStyles: FloatingStyles;
  update: () => void;
  onLayout: () => void;
  availableSize: { width: number; height: number } | null;
  actualPlacement: Placement;
}

export function useDropdownFloating({
  open,
  placement = "bottom",
  alignment = "start",
  offset = 8,
  padding = 8,
  referenceEl,
}: UseDropdownFloatingOptions): UseDropdownFloatingReturn {
  const floatingElRef = useRef<View | null>(null);
  const [geometry, setGeometry] = useState<GeometryResult | null>(null);

  const displayArea = useMemo(() => {
    const { width, height } = Dimensions.get("window");
    const statusBarHeight = Platform.OS === "android" ? (StatusBar.currentHeight ?? 0) : 0;
    return {
      x: 0,
      y: statusBarHeight,
      width,
      height: height - statusBarHeight,
    };
  }, []);

  const update = useCallback(async () => {
    console.log("[useDropdownFloating] update called", {
      hasReferenceEl: !!referenceEl,
      hasFloatingEl: !!floatingElRef.current,
    });

    if (!referenceEl || !floatingElRef.current) {
      return;
    }

    try {
      const [fromRect, contentRect] = await Promise.all([
        measureElement(referenceEl),
        measureElement(floatingElRef.current),
      ]);

      console.log("[useDropdownFloating] measured", {
        fromRect,
        contentRect,
        displayArea,
      });

      const result = computeGeometry({
        fromRect,
        contentSize: { width: contentRect.width, height: contentRect.height },
        displayArea,
        placement,
        alignment,
        offset,
        padding,
      });

      console.log("[useDropdownFloating] geometry result", result);

      setGeometry(result);
    } catch (e) {
      console.warn("[useDropdownFloating] measure failed:", e);
    }
  }, [referenceEl, displayArea, placement, alignment, offset, padding]);

  const floatingRef = useCallback((el: View | null) => {
    console.log("[useDropdownFloating] floatingRef called", { hasEl: !!el });
    floatingElRef.current = el;
  }, []);

  // Track when floating element is ready
  const [floatingReady, setFloatingReady] = useState(false);

  const handleFloatingLayout = useCallback(() => {
    console.log("[useDropdownFloating] handleFloatingLayout called");
    setFloatingReady(true);
  }, []);

  useEffect(() => {
    console.log("[useDropdownFloating] useEffect", {
      open,
      floatingReady,
      hasReferenceEl: !!referenceEl,
      hasFloatingEl: !!floatingElRef.current,
    });

    if (!open) {
      setGeometry(null);
      setFloatingReady(false);
      return;
    }

    if (floatingReady && referenceEl && floatingElRef.current) {
      console.log("[useDropdownFloating] calling update from useEffect");
      update();
    }
  }, [open, floatingReady, referenceEl, update]);

  const floatingStyles: FloatingStyles = {
    position: "absolute",
    top: geometry?.popoverOrigin.y ?? 0,
    left: geometry?.popoverOrigin.x ?? 0,
  };

  return {
    floatingRef,
    floatingStyles,
    update,
    onLayout: handleFloatingLayout,
    availableSize: geometry?.availableSize ?? null,
    actualPlacement: geometry?.placement ?? placement,
  };
}
