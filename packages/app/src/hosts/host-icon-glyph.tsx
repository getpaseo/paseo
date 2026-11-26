import type { ReactElement } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import {
  Cloud,
  Computer,
  Container,
  Cpu,
  Laptop,
  Monitor,
  PcCase,
  Server,
  Terminal,
} from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { DEFAULT_HOST_ICON, HOST_COLORS, type HostColor, type HostIcon } from "@/hosts/appearance";
import { identityForeground } from "@/styles/identity-colors";
import type { Theme } from "@/styles/theme";

const ThemedServer = withUnistyles(Server);
const ThemedLaptop = withUnistyles(Laptop);
const ThemedMonitor = withUnistyles(Monitor);
const ThemedComputer = withUnistyles(Computer);
const ThemedPcCase = withUnistyles(PcCase);
const ThemedCloud = withUnistyles(Cloud);
const ThemedContainer = withUnistyles(Container);
const ThemedCpu = withUnistyles(Cpu);
const ThemedTerminal = withUnistyles(Terminal);

const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

// One stable uniProps mapping per host color for the life of the module — a fresh identity on
// every render makes withUnistyles re-subscribe each pass. Reading `theme.colorScheme` inside the
// mapping keeps theme switches off React's render path.
const HOST_ICON_MAPPINGS: Record<HostColor, (theme: Theme) => { color: string }> = (() => {
  const byColor = {} as Record<HostColor, (theme: Theme) => { color: string }>;
  for (const color of HOST_COLORS) {
    byColor[color] =
      color === "none"
        ? mutedMapping
        : (theme: Theme) => ({ color: identityForeground(color, theme.colorScheme) });
  }
  return byColor;
})();

export function HostIconGlyph({
  icon = DEFAULT_HOST_ICON,
  color = "none",
  size = 16,
  style,
}: {
  icon?: HostIcon;
  color?: HostColor;
  size?: number;
  style?: StyleProp<ViewStyle>;
}): ReactElement {
  const uniProps = HOST_ICON_MAPPINGS[color];
  switch (icon) {
    case "laptop":
      return <ThemedLaptop size={size} style={style} uniProps={uniProps} />;
    case "desktop":
      return <ThemedMonitor size={size} style={style} uniProps={uniProps} />;
    case "mini":
      return <ThemedComputer size={size} style={style} uniProps={uniProps} />;
    case "workstation":
      return <ThemedPcCase size={size} style={style} uniProps={uniProps} />;
    case "cloud":
      return <ThemedCloud size={size} style={style} uniProps={uniProps} />;
    case "container":
      return <ThemedContainer size={size} style={style} uniProps={uniProps} />;
    case "board":
      return <ThemedCpu size={size} style={style} uniProps={uniProps} />;
    case "terminal":
      return <ThemedTerminal size={size} style={style} uniProps={uniProps} />;
    case "server":
      return <ThemedServer size={size} style={style} uniProps={uniProps} />;
  }
}
