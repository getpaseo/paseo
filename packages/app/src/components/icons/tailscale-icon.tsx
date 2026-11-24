import Svg, { Circle } from "react-native-svg";

const TAILSCALE_DOTS = [3, 12, 21].flatMap((cy, row) =>
  [3, 12, 21].map((cx, column) => ({
    cx,
    cy,
    // The Tailscale mark is a 3x3 dot grid with a solid T (middle row + bottom center).
    solid: row === 1 || (row === 2 && column === 1),
  })),
);

export interface TailscaleIconProps {
  size?: number;
  color?: string;
}

export function TailscaleIcon({ size = 12, color = "currentColor" }: TailscaleIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
      {TAILSCALE_DOTS.map((dot) => (
        <Circle
          key={`${dot.cx}:${dot.cy}`}
          cx={dot.cx}
          cy={dot.cy}
          r={3}
          fill={color}
          opacity={dot.solid ? 1 : 0.3}
        />
      ))}
    </Svg>
  );
}
