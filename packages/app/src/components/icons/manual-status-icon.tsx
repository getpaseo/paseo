import Svg, { Circle, Path } from "react-native-svg";
import type { SvgPathIconProps } from "./svg-path-icon";

// Forge-neutral rendering of GitLab's manual-status gear, aligned with the
// proportions of the other pipeline status icons.
const MANUAL_STATUS_GEAR_PATH =
  "M10.5 7.63V6.37l-.787-.13c-.044-.175-.132-.349-.263-.61l.481-.652-.918-.913-.657.478a2.346 2.346 0 0 0-.612-.26L7.656 3.5H6.388l-.132.783c-.219.043-.394.13-.612.26l-.657-.478-.918.913.437.652c-.131.218-.175.392-.262.61l-.744.086v1.261l.787.13c.044.218.132.392.263.61l-.438.651.92.913.655-.434c.175.086.394.173.613.26l.131.783h1.313l.131-.783c.219-.043.394-.13.613-.26l.656.478.918-.913-.48-.652c.13-.218.218-.435.262-.61l.656-.13zM7 8.283a1.285 1.285 0 0 1-1.313-1.305c0-.739.57-1.304 1.313-1.304.744 0 1.313.565 1.313 1.304 0 .74-.57 1.305-1.313 1.305z";

export function ManualStatusIcon({ size = 16, color = "currentColor" }: SvgPathIconProps) {
  return (
    <Svg width={size} height={size} viewBox="-0.5 -0.5 15 15">
      <Circle cx={7} cy={7} r={6.25} fill="none" stroke={color} strokeWidth={1.25} />
      <Path d={MANUAL_STATUS_GEAR_PATH} fill={color} />
    </Svg>
  );
}
