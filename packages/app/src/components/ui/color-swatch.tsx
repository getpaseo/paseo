import { View, Pressable, Text, StyleSheet } from "react-native";
import { useUnistyles } from "react-native-unistyles";

interface ColorSwatchProps {
  color: string;
  label?: string;
  size?: "sm" | "md" | "lg";
  selected?: boolean;
  onPress?: () => void;
}

export function ColorSwatch({
  color,
  label,
  size = "md",
  selected = false,
  onPress,
}: ColorSwatchProps) {
  const { theme } = useUnistyles();

  const sizeMap = {
    sm: 24,
    md: 32,
    lg: 48,
  };

  const swatchSize = sizeMap[size];

  const getContrastColor = (hex: string): string => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    return luminance > 0.5 ? "#000000" : "#ffffff";
  };

  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.container,
        {
          width: swatchSize + 8,
          height: swatchSize + (label ? 16 : 4),
        },
      ]}
    >
      <View
        style={[
          styles.swatch,
          {
            width: swatchSize,
            height: swatchSize,
            borderRadius: theme.borderRadius.sm,
            backgroundColor: color,
            borderWidth: selected ? 2 : 1,
            borderColor: selected ? theme.colors.ring : "rgba(0,0,0,0.1)",
          },
        ]}
      >
        {selected && (
          <View style={[styles.checkmark, { backgroundColor: getContrastColor(color) }]}>
            <Text style={[styles.checkmarkText, { color }]}>✓</Text>
          </View>
        )}
      </View>
      {label && (
        <Text style={[styles.label, { color: theme.colors.foregroundMuted }]} numberOfLines={1}>
          {label}
        </Text>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    padding: 2,
  },
  swatch: {
    justifyContent: "center",
    alignItems: "center",
  },
  checkmark: {
    width: 16,
    height: 16,
    borderRadius: 8,
    justifyContent: "center",
    alignItems: "center",
  },
  checkmarkText: {
    fontSize: 10,
    fontWeight: "bold",
  },
  label: {
    fontSize: 8,
    marginTop: 2,
  },
});