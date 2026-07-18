import Svg, { Path } from "react-native-svg";

interface OmpIconProps {
  size?: number;
  color?: string;
}

export function OmpIcon({ size = 16, color = "currentColor" }: OmpIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" fill={color}>
      <Path d="M10 14h44v9H43v33h-9V23h-9v22h-9V23H10z" />
    </Svg>
  );
}
