import Svg, { Path, Circle } from "react-native-svg";

interface AntigravityIconProps {
  size?: number;
  color?: string;
}

export function AntigravityIcon({ size = 16, color = "currentColor" }: AntigravityIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
      <Path d="M12 2L4 20h16L12 2zm0 3.5L18.5 18h-13L12 5.5z" fillRule="evenodd" />
      <Circle cx="12" cy="14" r="1.5" />
    </Svg>
  );
}
