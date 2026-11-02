import { useMemo, type ComponentType } from "react";
import { withUnistyles } from "react-native-unistyles";
import { densityIconSize, type DensityIconSize } from "@/styles/density";
import type { Theme } from "@/styles/theme";

type IconComponent = ComponentType<{ size: number; color: string; strokeWidth?: number }>;

type IconColor = {
  [K in keyof Theme["colors"]]: Theme["colors"][K] extends string ? K : never;
}[keyof Theme["colors"]];

function IconGlyph({
  icon: Icon,
  size,
  color,
  strokeWidth,
}: {
  icon: IconComponent;
  size: number;
  color: string;
  strokeWidth?: number;
}) {
  return <Icon size={size} color={color} strokeWidth={strokeWidth} />;
}

const ThemedIconGlyph = withUnistyles(IconGlyph);

/** An icon sized by density: larger on compact layouts. See `@/styles/density`. */
export function DensityIcon({
  icon,
  size,
  sizeAdjustment = 0,
  color,
  strokeWidth,
}: {
  icon: IconComponent;
  size: DensityIconSize;
  /** Only for a glyph that reads larger than others at the same size. */
  sizeAdjustment?: number;
  color: IconColor;
  strokeWidth?: number;
}) {
  const uniProps = useMemo(
    () => (theme: Theme, rt: { breakpoint?: string }) => ({
      size: densityIconSize(rt, size) + sizeAdjustment,
      color: theme.colors[color],
    }),
    [size, sizeAdjustment, color],
  );
  return <ThemedIconGlyph icon={icon} strokeWidth={strokeWidth} uniProps={uniProps} />;
}
