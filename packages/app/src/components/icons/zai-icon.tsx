import Svg, { Path } from "react-native-svg";

interface ZaiIconProps {
  size?: number;
  color?: string;
}

export function ZaiIcon({ size = 16, color = "currentColor" }: ZaiIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 16 16" fill={color} fillRule="evenodd">
      <Path d="M8.07 1.333 6.618 3.302H.435l1.452-1.969h6.184ZM15.503 12.699l-1.451 1.968H7.891l1.449-1.968h6.163ZM16 1.333 6.176 14.667H0L9.824 1.333H16Z" />
    </Svg>
  );
}
