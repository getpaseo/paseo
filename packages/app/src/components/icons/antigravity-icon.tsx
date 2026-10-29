import Svg, { Path } from "react-native-svg";

interface AntigravityIconProps {
  size?: number;
  color?: string;
}

export function AntigravityIcon({ size = 16, color = "currentColor" }: AntigravityIconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
      <Path
        transform="translate(12 12) scale(0.24) translate(-55.738 -56.945)"
        d="M89.6992 93.695C94.3659 97.195 101.366 94.8617 94.9492 88.445C75.6992 69.7783 79.7825 18.445 55.8659 18.445C31.9492 18.445 36.0325 69.7783 16.7825 88.445C9.78251 95.445 17.3658 97.195 22.0325 93.695C40.1159 81.445 38.9492 59.8617 55.8659 59.8617C72.7825 59.8617 71.6159 81.445 89.6992 93.695Z"
      />
    </Svg>
  );
}
