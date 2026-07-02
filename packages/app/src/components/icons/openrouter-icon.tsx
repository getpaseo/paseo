import Svg, { Path } from "react-native-svg";

interface OpenRouterIconProps {
  size?: number;
  color?: string;
}

export function OpenRouterIcon({ size = 16, color = "currentColor" }: OpenRouterIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M3 7H15.5L21 12L15.5 17H3M10 3V21M15 7V17"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}
