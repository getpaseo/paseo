import { Gauge } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { SvgIcon } from "@/components/provider-icons";
import type { Theme } from "@/styles/theme";

function UsageSourceIconBase({
  svg,
  size,
  color = "",
}: {
  svg: string | null;
  size: number;
  color?: string;
}) {
  if (!svg) return <Gauge size={size} color={color} />;
  return <SvgIcon svg={svg} size={size} color={color} />;
}

const ThemedUsageSourceIcon = withUnistyles(UsageSourceIconBase);

const mutedIconColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/** The source's catalog SVG, or a generic gauge when the source ships none. */
export function UsageSourceIcon({ svg, size }: { svg: string | null; size: number }) {
  return <ThemedUsageSourceIcon svg={svg} size={size} uniProps={mutedIconColor} />;
}
