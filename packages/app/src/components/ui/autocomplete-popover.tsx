import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type RefObject,
} from "react";
import { View, useWindowDimensions } from "react-native";
import { Portal } from "@gorhom/portal";
import Animated, {
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";
import { Autocomplete, type AutocompleteOption } from "@/components/ui/autocomplete";
import {
  measureFloatingPanelPortalHost,
  useFloatingPanelPortalHostName,
} from "@/components/ui/floating-panel-portal";
import { useKeyboardShift } from "@/keyboard/shift";
import { SPACING } from "@/styles/theme";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";

const OFFSET_FROM_ANCHOR = SPACING[3];

/**
 * Frames to keep re-measuring while the anchor or the portal host answer with no usable rect.
 * The host registers itself from an effect and both are measured through the layout engine, so
 * the first frames after the popover opens can come back empty or zero-sized. Nothing else
 * re-triggers measurement on a platform without keyboard motion, so without this the popover
 * stays hidden until the window is resized.
 */
const MEASUREMENT_RETRY_FRAMES = 12;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A missing host, a collapsed host or a zero-width anchor all mean layout has not produced the
 * geometry yet. Positioning against those values hides the popover just as thoroughly as not
 * rendering it, so they are treated as "not measured yet" rather than as a result.
 */
function isMeasured(anchorRect: Rect, hostRect: Rect | null): hostRect is Rect {
  return hostRect !== null && hostRect.height > 0 && anchorRect.width > 0;
}

interface RelativeAnchorRect {
  x: number;
  y: number;
  width: number;
  hostHeight: number;
}

function measureElement(element: View): Promise<Rect> {
  return new Promise((resolve) => {
    element.measureInWindow((x, y, width, height) => {
      resolve({ x, y, width, height });
    });
  });
}

interface AutocompletePopoverProps {
  visible: boolean;
  anchorRef: RefObject<View | null>;
  options: readonly AutocompleteOption[];
  selectedIndex: number;
  onSelect: (option: AutocompleteOption) => void;
  isLoading?: boolean;
  errorMessage?: string;
  loadingText?: string;
  emptyText?: string;
}

export function AutocompletePopover({
  visible,
  anchorRef,
  options,
  selectedIndex,
  onSelect,
  isLoading,
  errorMessage,
  loadingText,
  emptyText,
}: AutocompletePopoverProps): ReactElement | null {
  "use no memo";
  // React Compiler memoizes effect captures by reading SharedValue.value during render.
  const [relativeAnchorRect, setRelativeAnchorRect] = useState<RelativeAnchorRect | null>(null);
  const windowDimensions = useWindowDimensions();
  const safeAreaInsets = useSafeAreaInsets();
  const portalHostName = useFloatingPanelPortalHostName();
  const { shift, isMoving } = useKeyboardShift();
  const measuredShift = useSharedValue(0);
  const measurementGeneration = useRef(0);
  const retryFrame = useRef<number | null>(null);
  const retriesLeft = useRef(0);
  const canMeasure = visible && (options.length === 0 || selectedIndex >= 0);

  const remeasure = useCallback(() => {
    if (!canMeasure) return;
    const anchorElement = anchorRef.current;
    if (!anchorElement) return;
    const generation = measurementGeneration.current;
    void Promise.all([
      measureElement(anchorElement),
      measureFloatingPanelPortalHost(portalHostName),
    ]).then(([anchorRect, hostRect]) => {
      if (generation !== measurementGeneration.current) return undefined;
      if (!isMeasured(anchorRect, hostRect)) {
        // One retry in flight at a time, so the effect cleanup has a single frame to cancel.
        if (retriesLeft.current > 0 && retryFrame.current === null) {
          retriesLeft.current -= 1;
          retryFrame.current = requestAnimationFrame(() => {
            retryFrame.current = null;
            remeasure();
          });
        }
        return undefined;
      }
      setRelativeAnchorRect({
        x: anchorRect.x - hostRect.x,
        y: anchorRect.y - hostRect.y,
        width: anchorRect.width,
        hostHeight: hostRect.height,
      });
      measuredShift.value = shift.value;
      return undefined;
    });
  }, [anchorRef, canMeasure, measuredShift, portalHostName, shift]);

  useEffect(() => {
    measurementGeneration.current += 1;
    if (!canMeasure) {
      setRelativeAnchorRect(null);
      return;
    }

    retriesLeft.current = MEASUREMENT_RETRY_FRAMES;
    remeasure();
    const raf = requestAnimationFrame(remeasure);

    return () => {
      measurementGeneration.current += 1;
      cancelAnimationFrame(raf);
      if (retryFrame.current !== null) {
        cancelAnimationFrame(retryFrame.current);
        retryFrame.current = null;
      }
    };
  }, [canMeasure, remeasure, windowDimensions.width, windowDimensions.height]);

  useAnimatedReaction(
    () => isMoving.value,
    (moving, wasMoving) => {
      if (wasMoving && !moving) {
        scheduleOnRN(remeasure);
      }
    },
    [isMoving, remeasure],
  );

  const baseStyle = useMemo(() => {
    if (!relativeAnchorRect) return null;
    return inlineUnistylesStyle({
      position: "absolute" as const,
      left: relativeAnchorRect.x,
      width: relativeAnchorRect.width,
    });
  }, [relativeAnchorRect]);

  const anchorY = relativeAnchorRect?.y ?? 0;
  const baseBottom = relativeAnchorRect
    ? relativeAnchorRect.hostHeight - relativeAnchorRect.y + OFFSET_FROM_ANCHOR
    : 0;
  const keyboardLayoutStyle = useAnimatedStyle(() => {
    const shiftDelta = shift.value - measuredShift.value;
    return {
      bottom: baseBottom + shiftDelta,
      maxHeight: Math.max(0, anchorY - shiftDelta - safeAreaInsets.top - OFFSET_FROM_ANCHOR * 2),
    };
  }, [anchorY, baseBottom, safeAreaInsets.top]);

  if (!visible || !relativeAnchorRect || !baseStyle) return null;
  if (options.length > 0 && selectedIndex < 0) return null;

  return (
    <Portal hostName={portalHostName}>
      <View style={styles.overlay} pointerEvents="box-none">
        <Animated.View
          testID="composer-autocomplete-popover"
          style={[baseStyle, keyboardLayoutStyle]}
        >
          <Autocomplete
            options={options}
            selectedIndex={selectedIndex}
            onSelect={onSelect}
            isLoading={isLoading}
            errorMessage={errorMessage}
            loadingText={loadingText}
            emptyText={emptyText}
          />
        </Animated.View>
      </View>
    </Portal>
  );
}

const styles = StyleSheet.create(() => ({
  overlay: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
  },
}));
