import Svg, { Path } from "react-native-svg";

/**
 * The four-colour Play mark, the same one as the website's download buttons
 * (packages/website/src/downloads.tsx). Brand colours are fixed, so it takes no color.
 */
export function GooglePlayIcon({ size = 16 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M3.27 2.17c-.2.21-.32.55-.32 1v17.66c0 .45.12.79.33 1l9.87-9.84z" fill="#00F076" />
      <Path
        d="m16.43 8.72-3.28 3.27 3.29 3.28 3.9-2.22c1.13-.64 1.13-1.42 0-2.06z"
        fill="#FFCE00"
      />
      <Path d="m13.15 11.99 3.28-3.27L4.63 2.01c-.56-.32-1.04-.28-1.36.16z" fill="#00D6FF" />
      <Path d="M3.28 21.83c.32.44.8.48 1.36.16l11.8-6.72-3.29-3.28z" fill="#FF3A44" />
    </Svg>
  );
}
