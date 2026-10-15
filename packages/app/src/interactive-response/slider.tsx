import { useMemo, useRef, useState, useCallback } from "react";
import { PanResponder, Text, View, type LayoutChangeEvent } from "react-native";
import { styles } from "./styles";
export interface SliderProps {
  name: string;
  label: string;
  min: number;
  max: number;
  value: number;
  disabled: boolean;
  onChange: (name: string, value: number) => void;
}
export function InteractiveSlider({
  name,
  label,
  min,
  max,
  value,
  disabled,
  onChange,
}: SliderProps) {
  const [local, setLocal] = useState<number | null>(null);
  const width = useRef(1);
  const latest = useRef(value);
  const layout = useCallback((event: LayoutChangeEvent) => {
    width.current = Math.max(1, event.nativeEvent.layout.width);
  }, []);
  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => !disabled,
        onPanResponderGrant: (event) => {
          const next =
            min +
            Math.max(0, Math.min(1, event.nativeEvent.locationX / width.current)) * (max - min);
          latest.current = next;
          setLocal(next);
        },
        onPanResponderMove: (event) => {
          const next =
            min +
            Math.max(0, Math.min(1, event.nativeEvent.locationX / width.current)) * (max - min);
          latest.current = next;
          setLocal(next);
        },
        onPanResponderRelease: () => {
          onChange(name, latest.current);
          setLocal(null);
        },
        onPanResponderTerminate: () => setLocal(null),
      }),
    [disabled, min, max, name, onChange],
  );
  const displayed = local ?? value;
  const fill = useMemo(
    () => [
      styles.sliderFill,
      {
        width: `${max === min ? 0 : ((displayed - min) / (max - min)) * 100}%` as `${number}%`,
      },
    ],
    [displayed, min, max],
  );
  const accessibilityState = useMemo(() => ({ disabled }), [disabled]);
  const accessibilityValue = useMemo(() => ({ min, max, now: displayed }), [min, max, displayed]);
  const adjust = useCallback(
    (event: { nativeEvent: { actionName: string } }) => {
      if (disabled) return;
      const delta = (max - min) / 100;
      onChange(
        name,
        Math.max(
          min,
          Math.min(max, value + (event.nativeEvent.actionName === "increment" ? delta : -delta)),
        ),
      );
    },
    [onChange, name, min, max, value, disabled],
  );
  return (
    <View style={styles.content}>
      <Text style={styles.text}>
        {label}: {displayed.toFixed(1)}
      </Text>
      <View
        accessibilityRole="adjustable"
        accessibilityState={accessibilityState}
        accessibilityLabel={label}
        accessibilityValue={accessibilityValue}
        accessibilityActions={ACTIONS}
        onAccessibilityAction={adjust}
        onLayout={layout}
        style={styles.sliderTrack}
        {...pan.panHandlers}
      >
        <View style={fill} />
      </View>
    </View>
  );
}
const ACTIONS = [{ name: "increment" as const }, { name: "decrement" as const }];
