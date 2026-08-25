import Svg, { Path } from "react-native-svg";

interface OpenCodeV2IconProps {
  size?: number;
  color?: string;
}

// OpenCode 2 mark: the opencode "OC" frame plus a "2" badge in the top-right,
// distinguishing it from the v1 OpenCode icon (bare mark, no badge).
export function OpenCodeV2Icon({ size = 16, color = "currentColor" }: OpenCodeV2IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
      <Path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M3.5 4.5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-13Z"
        opacity={0.18}
      />
      <Path d="M10.3 15.15V11.55H6.1V15.15H10.3Z" opacity={0.4} />
      <Path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M12.4 17.25H4V6.75H12.4V17.25ZM10.3 15.15H6.1V8.85H10.3V15.15Z"
      />
      <Path
        d="M14 3.5a2.5 2.5 0 0 1 5 0v.5a2.5 2.5 0 0 1-.7 1.8L15 9h4"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </Svg>
  );
}
