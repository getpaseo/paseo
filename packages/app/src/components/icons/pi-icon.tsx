import Svg, { Path } from "react-native-svg";

interface PiIconProps {
  size?: number;
  color?: string;
}

export function PiIcon({ size = 16, color = "currentColor" }: PiIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 800 800" fill={color}>
      <Path
        d="M165.29 165.29 H517.36 V400 H400 V517.36 H282.65 V634.72 H165.29 Z M282.65 282.65 V400 H400 V282.65 Z"
        fill={color}
        fillRule="evenodd"
      />
      <Path d="M517.36 400 H634.72 V634.72 H517.36 Z" fill={color} />
    </Svg>
  );
}
