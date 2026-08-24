import { withUnistyles } from "react-native-unistyles";
import {
  BookOpen,
  Boxes,
  Brain,
  Bug,
  Cloud,
  Code,
  Compass,
  Cpu,
  Database,
  Eye,
  Feather,
  FileText,
  FlaskConical,
  GitBranch,
  Globe,
  Hammer,
  Layers,
  Microscope,
  Package,
  Palette,
  Pencil,
  Rocket,
  Search,
  Server,
  Shield,
  Sparkles,
  Star,
  Terminal,
  TestTube,
  Wrench,
} from "lucide-react-native";
import { identityForeground } from "@/styles/identity-colors";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import {
  AGENT_PROFILE_COLORS,
  resolveAgentProfileColor,
  resolveAgentProfileIconKey,
  type AgentProfileColor,
  type AgentProfileIconKey,
} from "./profile-appearance";

/** Drawn when a profile names no icon, and as the "default" cell in the picker grid. */
const ThemedDefaultIcon = withUnistyles(Star);

/**
 * `withUnistyles` has to wrap each icon once at module scope, so the registry
 * stores the themed component rather than the raw lucide one.
 */
const THEMED_ICONS: Record<AgentProfileIconKey, typeof ThemedDefaultIcon> = {
  code: withUnistyles(Code),
  terminal: withUnistyles(Terminal),
  bug: withUnistyles(Bug),
  wrench: withUnistyles(Wrench),
  hammer: withUnistyles(Hammer),

  flask: withUnistyles(FlaskConical),
  testTube: withUnistyles(TestTube),
  microscope: withUnistyles(Microscope),
  search: withUnistyles(Search),
  eye: withUnistyles(Eye),

  palette: withUnistyles(Palette),
  feather: withUnistyles(Feather),
  pencil: withUnistyles(Pencil),
  fileText: withUnistyles(FileText),
  book: withUnistyles(BookOpen),

  rocket: withUnistyles(Rocket),
  package: withUnistyles(Package),
  boxes: withUnistyles(Boxes),
  server: withUnistyles(Server),
  database: withUnistyles(Database),

  cpu: withUnistyles(Cpu),
  cloud: withUnistyles(Cloud),
  globe: withUnistyles(Globe),
  gitBranch: withUnistyles(GitBranch),
  layers: withUnistyles(Layers),

  compass: withUnistyles(Compass),
  brain: withUnistyles(Brain),
  sparkles: withUnistyles(Sparkles),
  shield: withUnistyles(Shield),
};

const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/**
 * One `uniProps` mapping per colour, built once. Building these inline would
 * hand `withUnistyles` a new function every render and defeat its tracking.
 */
const COLOR_MAPPINGS: Record<AgentProfileColor, (theme: Theme) => { color: string }> = (() => {
  const byColor = {} as Record<AgentProfileColor, (theme: Theme) => { color: string }>;
  for (const color of AGENT_PROFILE_COLORS) {
    byColor[color] =
      color === "none"
        ? mutedMapping
        : (theme: Theme) => ({ color: identityForeground(color, theme.colorScheme) });
  }
  return byColor;
})();

export function agentProfileColorMapping(
  color: AgentProfileColor,
): (theme: Theme) => { color: string } {
  return COLOR_MAPPINGS[color];
}

/**
 * How a profile is drawn everywhere it appears — settings list, model picker,
 * and the picker grid's own cells. One component so the three can't drift.
 */
export function AgentProfileGlyph({
  icon,
  color,
  size = ICON_SIZE.md,
}: {
  icon?: string | undefined;
  color?: string | undefined;
  size?: number;
}) {
  const iconKey = resolveAgentProfileIconKey(icon);
  const mapping = COLOR_MAPPINGS[resolveAgentProfileColor(color)];
  const Icon = iconKey ? THEMED_ICONS[iconKey] : ThemedDefaultIcon;
  return <Icon size={size} uniProps={mapping} />;
}
