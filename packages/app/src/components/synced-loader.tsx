import { useMemo } from "react";
import { View } from "react-native";
import Animated, {
  type SharedValue,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
} from "react-native-reanimated";
import { useSmallWidgetClock } from "@/hooks/use-small-widget-clock";
import {
  SYNCED_LOADER_DOT_COUNT,
  getSyncedLoaderDotOpacity,
  getSyncedLoaderStep,
} from "@/components/synced-loader-state";

const GRID_COLUMNS = 2;
const DOT_KEYS = Array.from({ length: SYNCED_LOADER_DOT_COUNT }, (_, i) => `dot-${i}`);
export function SyncedLoader({ size = 10, color }: { size?: number; color: string }) {
  const reduceMotion = useReducedMotion();
  const time = useSmallWidgetClock(!reduceMotion);
  const step = useDerivedValue(() => (reduceMotion ? 0 : getSyncedLoaderStep(time.value)));

  // The 2x3 grid fills `size` exactly on its long axis: the dot is whatever is left after
  // the two gaps, not a floored integer. Flooring cost the grid up to a third of a dot per
  // row — at size 10 it drew 8pt of ink in a 10pt box and read as a small mark in a large
  // slot. Fractional dots are fine here; these are sub-pixel radii on a moving glyph.
  const gap = Math.max(1, Math.round(size * 0.12));
  const dotSize = Math.max(2, (size - gap * 2) / 3);
  const gridWidth = dotSize * 2 + gap;
  const gridHeight = dotSize * 3 + gap * 2;

  const gridStyle = useMemo(
    () => ({ width: gridWidth, height: gridHeight }),
    [gridHeight, gridWidth],
  );
  const containerStyle = useMemo(
    () =>
      ({
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
      }) as const,
    [size],
  );

  return (
    <View style={containerStyle}>
      <View style={gridStyle}>
        {Array.from({ length: SYNCED_LOADER_DOT_COUNT }).map((_, dotIndex) => {
          const rowIndex = Math.floor(dotIndex / GRID_COLUMNS);
          const columnIndex = dotIndex % GRID_COLUMNS;

          return (
            <SpinnerDot
              key={DOT_KEYS[dotIndex]}
              color={color}
              dotSize={dotSize}
              dotIndex={dotIndex}
              step={step}
              left={columnIndex * (dotSize + gap)}
              top={rowIndex * (dotSize + gap)}
            />
          );
        })}
      </View>
    </View>
  );
}

function SpinnerDot({
  color,
  dotSize,
  dotIndex,
  step,
  left,
  top,
}: {
  color: string;
  dotSize: number;
  dotIndex: number;
  step: SharedValue<number>;
  left: number;
  top: number;
}) {
  const animatedStyle = useAnimatedStyle(() => ({
    opacity: getSyncedLoaderDotOpacity(step.value, dotIndex),
  }));

  const dotStyle = useMemo(
    () => [
      animatedStyle,
      {
        width: dotSize,
        height: dotSize,
        borderRadius: dotSize / 2,
        backgroundColor: color,
        position: "absolute" as const,
        left,
        top,
      },
    ],
    [animatedStyle, dotSize, color, left, top],
  );

  return <Animated.View style={dotStyle} />;
}
