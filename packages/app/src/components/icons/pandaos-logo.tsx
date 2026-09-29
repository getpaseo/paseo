import { StyleSheet } from "react-native-unistyles";
import Svg, { Circle, Path } from "react-native-svg";

interface PandaOSLogoProps {
  size?: number;
  color?: string;
}

const styles = StyleSheet.create((theme) => ({
  svg: {
    color: theme.colors.foreground,
  },
}));

export function PandaOSLogo({ size = 64, color }: PandaOSLogoProps) {
  const fillColor = color ?? styles.svg.color;

  return (
    <Svg width={size} height={size} viewBox="0 0 64 64" fill="none">
      {/* Head */}
      <Circle cx="32" cy="28" r="16" fill={fillColor} />
      {/* Left ear */}
      <Circle cx="20" cy="12" r="5" fill={fillColor} />
      {/* Right ear */}
      <Circle cx="44" cy="12" r="5" fill={fillColor} />
      {/* Left eye patch */}
      <Circle cx="26" cy="26" r="4" fill={fillColor} opacity="0.3" />
      {/* Right eye patch */}
      <Circle cx="38" cy="26" r="4" fill={fillColor} opacity="0.3" />
      {/* Left eye */}
      <Circle cx="26" cy="26" r="2" fill={fillColor} />
      {/* Right eye */}
      <Circle cx="38" cy="26" r="2" fill={fillColor} />
      {/* Snout */}
      <Circle cx="32" cy="35" r="3" fill={fillColor} />
      {/* Body */}
      <Path d="M 20 44 Q 20 52 32 52 Q 44 52 44 44 Z" fill={fillColor} />
    </Svg>
  );
}
