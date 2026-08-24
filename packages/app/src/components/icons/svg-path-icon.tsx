import Svg, { Path } from "react-native-svg";

export interface SvgPathIconProps {
  size?: number;
  color?: string;
}

interface SvgPathIconInput extends SvgPathIconProps {
  path: string;
  viewBox: string;
}

export function SvgPathIcon({
  size = 16,
  color = "currentColor",
  path,
  viewBox,
}: SvgPathIconInput) {
  return (
    <Svg width={size} height={size} viewBox={viewBox} fill={color}>
      <Path d={path} />
    </Svg>
  );
}
