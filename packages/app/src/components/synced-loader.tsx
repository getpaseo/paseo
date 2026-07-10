import { useMemo, useSyncExternalStore } from "react";
import { View } from "react-native";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { createSharedStepClock } from "@/components/synced-loader-clock";

const SYNCED_LOADER_DURATION_MS = 6_000;
const DOT_SEQUENCE = [0, 1, 3, 5, 4, 2] as const;
const DOT_COUNT = DOT_SEQUENCE.length;
const GRID_COLUMNS = 2;
const SNAKE_SEGMENT_OFFSETS = [0, -1, -2, -3, -4] as const;
const SNAKE_OPACITIES = [1, 0.78, 0.56, 0.34, 0] as const;
const DOT_INDEXES = Array.from({ length: DOT_COUNT }, (_, dotIndex) => dotIndex);
const DOT_KEYS = DOT_INDEXES.map((dotIndex) => `dot-${dotIndex}`);
const sharedStepClock = createSharedStepClock(DOT_COUNT, SYNCED_LOADER_DURATION_MS);
const subscribePaused = () => () => {};

export function SyncedLoader({ size = 10, color }: { size?: number; color: string }) {
  const active = useRetainedPanelActive();
  const step = useSyncExternalStore(
    active ? sharedStepClock.subscribe : subscribePaused,
    sharedStepClock.getSnapshot,
    sharedStepClock.getSnapshot,
  );

  const gap = Math.max(1, Math.round(size * 0.12));
  const dotSize = Math.max(2, Math.floor((size - gap * 2) / 3));
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
        {DOT_INDEXES.map((dotIndex) => {
          const rowIndex = Math.floor(dotIndex / GRID_COLUMNS);
          const columnIndex = dotIndex % GRID_COLUMNS;
          const sequenceIndex = DOT_SEQUENCE.indexOf(dotIndex as (typeof DOT_SEQUENCE)[number]);

          return (
            <SpinnerDot
              key={DOT_KEYS[dotIndex]}
              color={color}
              dotSize={dotSize}
              sequenceIndex={sequenceIndex}
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
  sequenceIndex,
  step,
  left,
  top,
}: {
  color: string;
  dotSize: number;
  sequenceIndex: number;
  step: number;
  left: number;
  top: number;
}) {
  let opacity = 0;

  for (let segmentIndex = 0; segmentIndex < SNAKE_SEGMENT_OFFSETS.length; segmentIndex += 1) {
    const activeSequenceIndex =
      (step + SNAKE_SEGMENT_OFFSETS[segmentIndex] + DOT_COUNT) % DOT_COUNT;
    if (sequenceIndex === activeSequenceIndex) {
      opacity = SNAKE_OPACITIES[segmentIndex] ?? 0;
      break;
    }
  }

  const dotStyle = useMemo(
    () => ({
      width: dotSize,
      height: dotSize,
      borderRadius: dotSize / 2,
      backgroundColor: color,
      position: "absolute" as const,
      left,
      top,
      opacity,
    }),
    [color, dotSize, left, opacity, top],
  );

  return <View style={dotStyle} />;
}
