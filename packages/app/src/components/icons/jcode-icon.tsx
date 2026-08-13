import Svg, { Path } from "react-native-svg";

interface JcodeIconProps {
  size?: number;
  color?: string;
}

// Jcode's identity is a terminal-first harness, so the provider glyph is a
// terminal prompt: a chevron with a cursor block.
export function JcodeIcon({ size = 16, color = "currentColor" }: JcodeIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
      <Path d="M4 5.2 11 12 4 18.8 6.4 12 4 5.2Z" />
      <Path d="M13 16.6h7.5v2.4H13z" />
    </Svg>
  );
}
