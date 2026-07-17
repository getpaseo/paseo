import Svg, { Circle, Rect } from "react-native-svg";

interface OmpIconProps {
  size?: number;
  color?: string;
}

export function OmpIcon({ size = 16, color = "currentColor" }: OmpIconProps) {
  // Ported from the Oh My Pi MIT-licensed assets/icon.svg mark.
  return (
    <Svg width={size} height={size} viewBox="0 0 120 90" fill="none">
      <Rect x={10} y={8} width={100} height={12} rx={2} fill={color} />
      <Rect x={25} y={20} width={12} height={62} rx={2} fill={color} />
      <Rect x={75} y={20} width={12} height={45} rx={2} fill={color} />
      <Rect x={71} y={55} width={20} height={16} rx={3} fill="#f97316" />
      <Rect x={76} y={59} width={3} height={8} rx={1} fill="#0d0d0d" />
      <Rect x={82} y={59} width={3} height={8} rx={1} fill="#0d0d0d" />
      <Circle cx={18} cy={14} r={2} fill="#f97316" opacity={0.8} />
      <Circle cx={102} cy={14} r={2} fill="#f97316" opacity={0.8} />
    </Svg>
  );
}
