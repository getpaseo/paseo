import Svg, { Path } from "react-native-svg";

interface MuseIconProps {
  size?: number;
  color?: string;
}

export function MuseIcon({ size = 16, color = "currentColor" }: MuseIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M4.5 19.5v-13l5 6.5 2.5-3.25 2.5 3.25 5-6.5v13"
        stroke={color}
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}
