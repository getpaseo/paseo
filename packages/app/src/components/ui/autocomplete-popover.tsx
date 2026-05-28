import { useEffect, useMemo, useState, type ReactElement, type RefObject } from "react";
import { Keyboard, View, useWindowDimensions } from "react-native";
import { Portal } from "@gorhom/portal";
import Animated, {
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
} from "react-native-reanimated";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet } from "react-native-unistyles";
import { Autocomplete, type AutocompleteOption } from "@/components/ui/autocomplete";
import {
  measureFloatingPanelPortalHost,
  useFloatingPanelPortalHostName,
} from "@/components/ui/floating-panel-portal";
import { SPACING } from "@/styles/theme";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";

const OFFSET_FROM_ANCHOR = SPACING[3];

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
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
  const insets = useSafeAreaInsets();
  const portalHostName = useFloatingPanelPortalHostName();

  const { height: rawKeyboardHeight } = useReanimatedKeyboardAnimation();
  const bottomInsetSV = useSharedValue(insets.bottom);
  useEffect(() => {
    bottomInsetSV.value = insets.bottom;
  }, [bottomInsetSV, insets.bottom]);

  const shift = useDerivedValue(() =>
    Math.max(0, Math.abs(rawKeyboardHeight.value) - bottomInsetSV.value),
  );
  const openShift = useSharedValue(0);

  useEffect(() => {
    if (!visible || (options.length > 0 && selectedIndex < 0)) {
      setRelativeAnchorRect(null);
      return;
    }

    let cancelled = false;
    const remeasure = () => {
      const anchorElement = anchorRef.current;
      if (!anchorElement) return;
      void Promise.all([
        measureElement(anchorElement),
        measureFloatingPanelPortalHost(portalHostName),
      ]).then(([anchorRect, hostRect]) => {
        if (cancelled || !hostRect) return undefined;
        setRelativeAnchorRect({
          x: anchorRect.x - hostRect.x,
          y: anchorRect.y - hostRect.y,
          width: anchorRect.width,
          hostHeight: hostRect.height,
        });
        openShift.value = shift.value;
        return undefined;
      });
    };

    remeasure();
    const raf = requestAnimationFrame(remeasure);
    const subscriptions = (["keyboardDidShow", "keyboardDidHide"] as const).map((event) =>
      Keyboard.addListener(event, () => requestAnimationFrame(remeasure)),
    );

    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      for (const sub of subscriptions) sub.remove();
    };
  }, [
    visible,
    options.length,
    selectedIndex,
    anchorRef,
    portalHostName,
    openShift,
    shift,
    windowDimensions.width,
    windowDimensions.height,
  ]);

  const baseStyle = useMemo(() => {
    if (!relativeAnchorRect) return null;
    return inlineUnistylesStyle({
      position: "absolute" as const,
      bottom: relativeAnchorRect.hostHeight - relativeAnchorRect.y + OFFSET_FROM_ANCHOR,
      left: relativeAnchorRect.x,
      width: relativeAnchorRect.width,
    });
  }, [relativeAnchorRect]);

  const animatedTransformStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: openShift.value - shift.value }],
  }));

  const composedStyle = useMemo(
    () => [baseStyle, animatedTransformStyle],
    [baseStyle, animatedTransformStyle],
  );

  if (!visible || !relativeAnchorRect || !baseStyle) return null;
  if (options.length > 0 && selectedIndex < 0) return null;

  return (
    <Portal hostName={portalHostName}>
      <View style={styles.overlay} pointerEvents="box-none">
        <Animated.View testID="composer-autocomplete-popover" style={composedStyle}>
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
