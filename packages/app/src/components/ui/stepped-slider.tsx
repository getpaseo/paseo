import { useCallback, useMemo, useRef, useState } from "react";
import { Pressable, Text, View, type LayoutChangeEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { StyleSheet } from "react-native-unistyles";
import * as Haptics from "expo-haptics";
import { isNative } from "@/constants/platform";
import { resolveSliderFraction, resolveSliderIndexFromX } from "./stepped-slider-math";

const TRACK_HEIGHT = 28;
const TRACK_INSET = 2;
const THUMB_SIZE = TRACK_HEIGHT - TRACK_INSET * 2;
const THUMB_RADIUS = THUMB_SIZE / 2;
/** Matches `TRACK_HEIGHT / 2` so the circular thumb stays concentric with the capsule and fill caps. */
const TRAVEL_EDGE = TRACK_INSET + THUMB_RADIUS;
const DOT_SIZE = 6;
const DOT_RADIUS = DOT_SIZE / 2;

export interface SteppedSliderOption<T extends string> {
  value: T;
  label: string;
  testID?: string;
}

interface SteppedSliderProps<T extends string> {
  options: readonly SteppedSliderOption<T>[];
  value: T | null;
  onValueChange: (value: T) => void;
  /** Fires while scrubbing so a header label can preview the stop before release. */
  onPreviewChange?: (value: T | null) => void;
  disabled?: boolean;
  accessibilityLabel?: string;
  testID?: string;
}

function triggerSelectionHaptic() {
  if (!isNative) return;
  void Haptics.selectionAsync().catch(() => {});
}

/**
 * A thick capsule slider with discrete stop dots, matching Paseo's Switch proportions. Tapping any
 * stop picks it immediately; dragging horizontally scrubs across stops without blocking vertical
 * sheet scrolling.
 */
export function SteppedSlider<T extends string>({
  options,
  value,
  onValueChange,
  onPreviewChange,
  disabled = false,
  accessibilityLabel,
  testID,
}: SteppedSliderProps<T>) {
  const travelWidthRef = useRef(0);
  const [scrubIndex, setScrubIndex] = useState<number | null>(null);
  const scrubIndexRef = useRef<number | null>(null);

  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const activeIndex = scrubIndex ?? selectedIndex;
  const fraction = resolveSliderFraction(activeIndex, options.length);

  const handleTravelLayout = useCallback((event: LayoutChangeEvent) => {
    travelWidthRef.current = event.nativeEvent.layout.width;
  }, []);

  const updateScrubFromX = useCallback(
    (x: number) => {
      const nextIndex = resolveSliderIndexFromX(
        x - TRAVEL_EDGE,
        travelWidthRef.current,
        options.length,
      );
      if (nextIndex === scrubIndexRef.current) return;
      scrubIndexRef.current = nextIndex;
      setScrubIndex(nextIndex);
      const option = options[nextIndex];
      if (option) {
        onPreviewChange?.(option.value);
        triggerSelectionHaptic();
      }
    },
    [onPreviewChange, options],
  );

  const commitScrub = useCallback(() => {
    const finalIndex = scrubIndexRef.current;
    scrubIndexRef.current = null;
    setScrubIndex(null);
    onPreviewChange?.(null);
    if (finalIndex === null) return;
    const option = options[finalIndex];
    if (option && option.value !== value) {
      onValueChange(option.value);
    }
  }, [onPreviewChange, onValueChange, options, value]);

  const cancelScrub = useCallback(() => {
    scrubIndexRef.current = null;
    setScrubIndex(null);
    onPreviewChange?.(null);
  }, [onPreviewChange]);

  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(!disabled && options.length > 1)
        .activeOffsetX([-6, 6])
        .failOffsetY([-12, 12])
        .runOnJS(true)
        .onBegin((event) => {
          updateScrubFromX(event.x);
        })
        .onUpdate((event) => {
          updateScrubFromX(event.x);
        })
        .onEnd(() => {
          commitScrub();
        })
        .onFinalize((_, success) => {
          if (!success) cancelScrub();
        }),
    [cancelScrub, commitScrub, disabled, options.length, updateScrubFromX],
  );

  const handleSelectOption = useCallback(
    (optionValue: T) => {
      if (disabled || optionValue === value) return;
      triggerSelectionHaptic();
      onValueChange(optionValue);
    },
    [disabled, onValueChange, value],
  );

  const containerStyle = useMemo(() => [styles.container, disabled && styles.disabled], [disabled]);
  const fillAnchorStyle = useMemo(
    () => [styles.fillAnchor, { width: `${fraction * 100}%` as const }],
    [fraction],
  );
  const thumbStyle = useMemo(
    () => [styles.thumb, { left: `${fraction * 100}%` as const }],
    [fraction],
  );

  const firstOption = options[0];
  const lastOption = options[options.length - 1];

  return (
    <View style={containerStyle} accessibilityLabel={accessibilityLabel} testID={testID}>
      <GestureDetector gesture={panGesture}>
        <View style={styles.trackBand}>
          <View style={styles.capsule}>
            <View style={styles.travelArea} onLayout={handleTravelLayout} pointerEvents="none">
              {activeIndex > 0 ? (
                <View style={fillAnchorStyle}>
                  <View style={styles.trackFill} />
                </View>
              ) : null}
              {options.map((option, index) => (
                <StopDot
                  key={option.value}
                  fraction={resolveSliderFraction(index, options.length)}
                  filled={index < activeIndex}
                />
              ))}
              <View style={thumbStyle} />
            </View>
          </View>
          <View style={styles.hitRow}>
            {options.map((option, index) => (
              <StopHitTarget
                key={option.value}
                option={option}
                selected={index === activeIndex}
                disabled={disabled}
                onSelect={handleSelectOption}
              />
            ))}
          </View>
        </View>
      </GestureDetector>
      {firstOption && lastOption && firstOption.value !== lastOption.value ? (
        <View style={styles.endpoints} pointerEvents="none">
          <Text style={styles.endpointLabel} numberOfLines={1}>
            {firstOption.label}
          </Text>
          <Text style={styles.endpointLabel} numberOfLines={1}>
            {lastOption.label}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

function StopDot({ fraction, filled }: { fraction: number; filled: boolean }) {
  const style = useMemo(
    () => [
      styles.dot,
      filled ? styles.dotFilled : styles.dotIdle,
      { left: `${fraction * 100}%` as const },
    ],
    [filled, fraction],
  );
  return <View style={style} pointerEvents="none" />;
}

function StopHitTarget<T extends string>({
  option,
  selected,
  disabled,
  onSelect,
}: {
  option: SteppedSliderOption<T>;
  selected: boolean;
  disabled: boolean;
  onSelect: (value: T) => void;
}) {
  const handlePress = useCallback(() => onSelect(option.value), [onSelect, option.value]);
  const accessibilityState = useMemo(() => ({ selected, disabled }), [disabled, selected]);
  return (
    <Pressable
      onPress={handlePress}
      disabled={disabled}
      accessibilityRole="radio"
      accessibilityLabel={option.label}
      accessibilityState={accessibilityState}
      aria-selected={selected}
      style={styles.hitTarget}
      testID={option.testID}
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[1],
  },
  disabled: {
    opacity: theme.opacity[50],
  },
  trackBand: {
    height: 36,
    justifyContent: "center",
  },
  capsule: {
    height: TRACK_HEIGHT,
    borderRadius: TRACK_HEIGHT / 2,
    backgroundColor: theme.colors.surface3,
    overflow: "hidden",
    paddingHorizontal: TRAVEL_EDGE,
  },
  travelArea: {
    flex: 1,
    justifyContent: "center",
  },
  fillAnchor: {
    position: "absolute",
    left: 0,
    top: 0,
    bottom: 0,
  },
  trackFill: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: -TRAVEL_EDGE,
    right: -TRAVEL_EDGE,
    borderRadius: TRACK_HEIGHT / 2,
    backgroundColor: theme.colors.accent,
  },
  dot: {
    position: "absolute",
    width: DOT_SIZE,
    height: DOT_SIZE,
    borderRadius: DOT_RADIUS,
    marginLeft: -DOT_RADIUS,
  },
  dotFilled: {
    backgroundColor: theme.colors.accentForeground,
    opacity: 0.5,
  },
  dotIdle: {
    backgroundColor: theme.colors.foregroundExtraMuted,
    opacity: 0.75,
  },
  thumb: {
    position: "absolute",
    width: THUMB_SIZE,
    height: THUMB_SIZE,
    borderRadius: THUMB_RADIUS,
    marginLeft: -THUMB_RADIUS,
    backgroundColor: theme.colors.palette.white,
    shadowColor: "rgba(0, 0, 0, 0.25)",
    shadowOffset: { width: 0, height: 1 },
    shadowRadius: 2,
    shadowOpacity: 1,
    elevation: 2,
  },
  hitRow: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    flexDirection: "row",
  },
  hitTarget: {
    flex: 1,
    height: "100%",
  },
  endpoints: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 2,
  },
  endpointLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
}));
