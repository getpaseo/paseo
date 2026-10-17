import { withUnistyles } from "react-native-unistyles";
import {
  Box,
  Building2,
  Cloud,
  Cpu,
  House,
  Laptop,
  Monitor,
  PcCase,
  Server,
} from "lucide-react-native";
import type { HostIcon } from "@/hosts/appearance";

/**
 * One themed glyph per host icon, wrapped once for the life of the module so every surface
 * that draws a host — the sidebar badge, the settings picker — colors it through `uniProps`.
 */
export const THEMED_HOST_ICONS = {
  server: withUnistyles(Server),
  cloud: withUnistyles(Cloud),
  desktop: withUnistyles(Monitor),
  laptop: withUnistyles(Laptop),
  workstation: withUnistyles(PcCase),
  board: withUnistyles(Cpu),
  container: withUnistyles(Box),
  home: withUnistyles(House),
  office: withUnistyles(Building2),
} satisfies Record<HostIcon, unknown>;
