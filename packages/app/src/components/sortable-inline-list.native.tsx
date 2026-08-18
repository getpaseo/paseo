import { Fragment, useCallback, useMemo, useRef, useState, type ReactElement } from "react";
import type { LayoutChangeEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import type { SharedValue } from "react-native-reanimated";
import * as Haptics from "expo-haptics";
import type { DraggableRenderItemInfo } from "./draggable-list.types";

// Mirrors the sidebar's long-press drag values (use-long-press-drag-interaction
// arm delay + DraggableFlatList activationDistance + resize fail offset).
const LONG_PRESS_ACTIVATION_MS = 180;
const HORIZONTAL_ACTIVATION_SLOP = 20;
const VERTICAL_SCROLL_SLOP = 12;
const DRAG_SCALE = 1.02;
const DRAG_OPACITY = 0.9;

/**
 * Resolves the index a chip would land on given a finger offset relative to
 * the chip's original left edge. Chips have measured (per-item) widths, so the
 * math walks cumulative widths instead of assuming a fixed stride.
 */
function computeTargetIndex(startIndex: number, translation: number, widths: number[]): number {
  "worklet";
  if (widths.length === 0) {
    return startIndex;
  }
  let prefix = 0;
  for (let i = 0; i < startIndex && i < widths.length; i++) {
    prefix += widths[i];
  }
  const finger = prefix + translation;
  let acc = 0;
  for (let i = 0; i < widths.length; i++) {
    acc += widths[i];
    if (finger <= acc) {
      return i;
    }
  }
  return widths.length - 1;
}

export function SortableInlineList<T>({
  data,
  keyExtractor,
  renderItem,
  onDragEnd,
  useDragHandle: _useDragHandle,
  disabled = false,
  externalDndContext = false,
  activeId: _activeId,
  getItemData: _getItemData,
}: {
  data: T[];
  keyExtractor: (item: T, index: number) => string;
  renderItem: (info: DraggableRenderItemInfo<T>) => ReactElement;
  onDragEnd?: (data: T[]) => void;
  useDragHandle?: boolean;
  disabled?: boolean;
  externalDndContext?: boolean;
  activeId?: string | null;
  getItemData?: (item: T, index: number) => Record<string, unknown>;
}): ReactElement {
  // Cross-pane drags need the external dnd context, which native does not have.
  const canDrag = !disabled && !externalDndContext && data.length > 1;
  const dragIndex = useSharedValue(-1);
  const translationX = useSharedValue(0);
  const targetIndex = useSharedValue(-1);
  const widths = useSharedValue<number[]>([]);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const dataRef = useRef(data);
  dataRef.current = data;
  const onDragEndRef = useRef(onDragEnd);
  onDragEndRef.current = onDragEnd;

  const commitReorder = useCallback((from: number, to: number) => {
    if (from === to) {
      return;
    }
    const current = dataRef.current;
    const next = [...current];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onDragEndRef.current?.(next);
  }, []);

  const resetDragState = useCallback(() => {
    "worklet";
    dragIndex.value = -1;
    translationX.value = 0;
    targetIndex.value = -1;
    runOnJS(setActiveIndex)(null);
  }, [dragIndex, targetIndex, translationX]);

  if (!canDrag) {
    return (
      <>
        {data.map((item, index) => {
          const id = keyExtractor(item, index);
          const info: DraggableRenderItemInfo<T> = {
            item,
            index,
            drag: () => {},
            isActive: false,
          };
          return <Fragment key={id}>{renderItem(info)}</Fragment>;
        })}
      </>
    );
  }

  return (
    <>
      {data.map((item, index) => {
        const id = keyExtractor(item, index);
        const info: DraggableRenderItemInfo<T> = {
          item,
          index,
          drag: () => {},
          isActive: activeIndex === index,
        };
        return (
          <SortableNativeItem
            key={id}
            index={index}
            renderItem={renderItem}
            info={info}
            dragIndex={dragIndex}
            translationX={translationX}
            targetIndex={targetIndex}
            widths={widths}
            setActiveIndex={setActiveIndex}
            commitReorder={commitReorder}
            resetDragState={resetDragState}
          />
        );
      })}
    </>
  );
}

interface SortableNativeItemProps<T> {
  index: number;
  renderItem: (info: DraggableRenderItemInfo<T>) => ReactElement;
  info: DraggableRenderItemInfo<T>;
  dragIndex: SharedValue<number>;
  translationX: SharedValue<number>;
  targetIndex: SharedValue<number>;
  widths: SharedValue<number[]>;
  setActiveIndex: (index: number | null) => void;
  commitReorder: (from: number, to: number) => void;
  resetDragState: () => void;
}

function SortableNativeItem<T>({
  index,
  renderItem,
  info,
  dragIndex,
  translationX,
  targetIndex,
  widths,
  setActiveIndex,
  commitReorder,
  resetDragState,
}: SortableNativeItemProps<T>) {
  const touchStartX = useSharedValue(0);
  const touchStartY = useSharedValue(0);
  const touchStartTime = useSharedValue(0);

  const gesture = useMemo(
    () =>
      Gesture.Pan()
        .manualActivation(true)
        .shouldCancelWhenOutside(false)
        .onTouchesDown((event, stateManager) => {
          const touch = event.changedTouches[0];
          if (!touch) {
            stateManager.fail();
            return;
          }
          touchStartX.value = touch.absoluteX;
          touchStartY.value = touch.absoluteY;
          touchStartTime.value = Date.now();
        })
        .onTouchesMove((event, stateManager) => {
          const touch = event.changedTouches[0];
          if (!touch) {
            return;
          }
          const dx = touch.absoluteX - touchStartX.value;
          const dy = touch.absoluteY - touchStartY.value;
          // Vertical intent keeps scrolling the tab row instead of dragging.
          if (Math.abs(dy) > VERTICAL_SCROLL_SLOP && Math.abs(dy) > Math.abs(dx)) {
            stateManager.fail();
            return;
          }
          const elapsed = Date.now() - touchStartTime.value;
          if (elapsed >= LONG_PRESS_ACTIVATION_MS && Math.abs(dx) > HORIZONTAL_ACTIVATION_SLOP) {
            stateManager.activate();
          }
        })
        .onStart(() => {
          dragIndex.value = index;
          translationX.value = 0;
          targetIndex.value = index;
          runOnJS(setActiveIndex)(index);
          void Haptics.selectionAsync().catch(() => {});
        })
        .onUpdate((event) => {
          translationX.value = event.translationX;
          targetIndex.value = computeTargetIndex(index, event.translationX, widths.value);
        })
        .onEnd((_event, success) => {
          const from = dragIndex.value;
          const to = targetIndex.value;
          resetDragState();
          if (success && from >= 0 && to >= 0) {
            runOnJS(commitReorder)(from, to);
          }
        })
        .onFinalize(() => {
          if (dragIndex.value === index) {
            resetDragState();
          }
        }),
    [commitReorder, dragIndex, index, resetDragState, setActiveIndex, targetIndex, touchStartTime, touchStartX, touchStartY, translationX, widths],
  );

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const next = widths.value.slice();
      next[index] = event.nativeEvent.layout.width;
      widths.value = next;
    },
    [index, widths],
  );

  const animatedStyle = useAnimatedStyle(() => {
    const dragging = dragIndex.value;
    if (dragging < 0) {
      return {};
    }
    if (index === dragging) {
      return {
        transform: [{ translateX: translationX.value }, { scale: DRAG_SCALE }],
        zIndex: 10,
        opacity: DRAG_OPACITY,
      };
    }
    const target = targetIndex.value;
    if (target < 0) {
      return {};
    }
    const shift = widths.value[dragging] ?? 0;
    if (index < dragging && index >= target) {
      return { transform: [{ translateX: shift }] };
    }
    if (index > dragging && index <= target) {
      return { transform: [{ translateX: -shift }] };
    }
    return {};
  });

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View onLayout={handleLayout} style={animatedStyle}>
        {renderItem(info)}
      </Animated.View>
    </GestureDetector>
  );
}
