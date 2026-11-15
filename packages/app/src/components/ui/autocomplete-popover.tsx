import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import { View, useWindowDimensions, type StyleProp, type ViewStyle } from "react-native";
import { Portal } from "@gorhom/portal";
import Animated, {
  useAnimatedReaction,
  useAnimatedStyle,
  type DerivedValue,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Autocomplete,
  type AutocompleteOption,
  type AutocompleteStatus,
} from "@/components/ui/autocomplete";
import {
  measureFloatingPanelPortalHost,
  useFloatingPanelPortalHostName,
} from "@/components/ui/floating-panel-portal";
import { KeyboardTranslateView, useKeyboardAnchor, useKeyboardShift } from "@/keyboard/shift";
import { SPACING } from "@/styles/theme";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";

const OFFSET_FROM_ANCHOR = SPACING[3];

interface RelativeAnchorRect {
  x: number;
  y: number;
  width: number;
  hostHeight: number;
}

interface AutocompletePopoverProps {
  visible: boolean;
  children: ReactNode;
  anchorStyle?: StyleProp<ViewStyle>;
  options: readonly AutocompleteOption[];
  selectedIndex: number;
  onSelect: (option: AutocompleteOption) => void;
  status?: AutocompleteStatus | null;
}

export function AutocompletePopover({
  visible,
  children,
  anchorStyle,
  options,
  selectedIndex,
  onSelect,
  status,
}: AutocompletePopoverProps): ReactElement | null {
  "use no memo";
  // React Compiler memoizes effect captures by reading SharedValue.value during render.
  const anchorRef = useRef<View>(null);
  const [relativeAnchorRect, setRelativeAnchorRect] = useState<RelativeAnchorRect | null>(null);
  const windowDimensions = useWindowDimensions();
  const safeAreaInsets = useSafeAreaInsets();
  const portalHostName = useFloatingPanelPortalHostName();
  const { isMoving } = useKeyboardShift();
  const anchor = useKeyboardAnchor();
  const { measureAtRest } = anchor;
  const measurementGeneration = useRef(0);
  const canMeasure = visible && (options.length === 0 || selectedIndex >= 0);

  const remeasure = useCallback(() => {
    if (!canMeasure) return;
    const anchorElement = anchorRef.current;
    if (!anchorElement) return;
    const generation = measurementGeneration.current;
    void Promise.all([
      measureAtRest(anchorElement),
      measureFloatingPanelPortalHost(portalHostName),
    ]).then(([anchorRect, hostRect]) => {
      if (generation !== measurementGeneration.current || !anchorRect || !hostRect) {
        return undefined;
      }
      setRelativeAnchorRect({
        x: anchorRect.x - hostRect.x,
        y: anchorRect.y - hostRect.y,
        width: anchorRect.width,
        hostHeight: hostRect.height,
      });
      return undefined;
    });
  }, [anchorRef, canMeasure, measureAtRest, portalHostName]);

  useEffect(() => {
    measurementGeneration.current += 1;
    if (!canMeasure) {
      setRelativeAnchorRect(null);
      return;
    }

    remeasure();
    const raf = requestAnimationFrame(remeasure);

    return () => {
      measurementGeneration.current += 1;
      cancelAnimationFrame(raf);
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

  // Lay out at the anchor's resting position; the KeyboardTranslateView below lifts
  // it with the anchor. Height changes only at keyboard boundaries.
  const baseStyle = useMemo(() => {
    if (!relativeAnchorRect) return null;
    return inlineUnistylesStyle({
      position: "absolute" as const,
      left: relativeAnchorRect.x,
      width: relativeAnchorRect.width,
      bottom: relativeAnchorRect.hostHeight - relativeAnchorRect.y + OFFSET_FROM_ANCHOR,
    });
  }, [relativeAnchorRect]);

  // The translate view is the popover's own frame, so it lifts only the popover.
  return (
    <View ref={anchorRef} onLayout={remeasure} style={anchorStyle} collapsable={false}>
      {children}
      {canMeasure && relativeAnchorRect && baseStyle ? (
        <Portal hostName={portalHostName}>
          <KeyboardTranslateView {...anchor.translation} style={baseStyle}>
            <PopoverFrame
              anchorY={relativeAnchorRect.y}
              reservedLift={anchor.reservedLift}
              topInset={safeAreaInsets.top}
            >
              <Autocomplete
                options={options}
                selectedIndex={selectedIndex}
                onSelect={onSelect}
                status={status}
              />
            </PopoverFrame>
          </KeyboardTranslateView>
        </Portal>
      ) : null}
    </View>
  );
}

interface PopoverFrameProps {
  anchorY: number;
  reservedLift: DerivedValue<number>;
  topInset: number;
  children: ReactNode;
}

/**
 * Bounds the popover's height to the space above the anchor. It mounts only with a measured
 * anchor: Reanimated computes the first style when the hook first runs and sends later values
 * after the mounting commit, which native paints. A bound computed before the measurement painted
 * the popover at its minimum height, hanging over the composer, for a frame on every open.
 */
function PopoverFrame({
  anchorY,
  reservedLift,
  topInset,
  children,
}: PopoverFrameProps): ReactElement {
  "use no memo";
  // React Compiler memoizes effect captures by reading SharedValue.value during render.
  const heightStyle = useAnimatedStyle(
    () => ({
      maxHeight: Math.max(0, anchorY - reservedLift.value - topInset - OFFSET_FROM_ANCHOR * 2),
    }),
    [anchorY, reservedLift, topInset],
  );
  return (
    <Animated.View testID="composer-autocomplete-popover" style={heightStyle}>
      {children}
    </Animated.View>
  );
}
