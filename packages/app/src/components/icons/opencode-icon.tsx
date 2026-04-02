import Svg, { Path } from "react-native-svg";

interface OpenCodeIconProps {
  size?: number;
  color?: string;
}

export function OpenCodeIcon({ size = 16, color = "currentColor" }: OpenCodeIconProps) {
  return (
    <Svg width={size} height={size} viewBox="96 64 288 384" fill={color}>
      <Path d="M320 224V352H192V224H320Z" opacity={0.4} />
      <Path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M384 416H128V96H384V416ZM320 160H192V352H320V160Z"
      />
    </Svg>
  );
}
