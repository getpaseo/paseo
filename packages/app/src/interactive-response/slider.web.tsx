import { useCallback, type ChangeEvent } from "react";
import { Text, View } from "react-native";
import { styles } from "./styles";
import type { SliderProps } from "./slider";
export function InteractiveSlider({
  name,
  label,
  min,
  max,
  value,
  disabled,
  onChange,
}: SliderProps) {
  const change = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => onChange(name, Number(event.target.value)),
    [name, onChange],
  );
  return (
    <View style={styles.content}>
      <Text style={styles.text}>
        {label}: {value.toFixed(1)}
      </Text>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step="any"
        value={value}
        disabled={disabled}
        onChange={change}
      />
    </View>
  );
}
