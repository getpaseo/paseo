import { Pressable, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  Sparkles,
  Bot,
  SquareTerminal,
  MousePointerClick,
  Zap,
  Sparkle,
  Braces,
  Github,
  Box,
  Terminal,
  CircuitBoard,
  Feather,
  Hammer,
  Flame,
  Gauge,
  Waves,
  Compass,
  Rocket,
  Anchor,
  Wrench,
  Cpu,
} from "lucide-react-native";
import { TRANSPORT_BY_TARGET, type LibrarySyncTarget, type McpTransport } from "@/api/library";
import type { ReactNode } from "react";
import { useInstalledAgents } from "@/hooks/library/use-installed-agents";

interface AgentDisplay {
  id: LibrarySyncTarget;
  label: string;
  icon: ReactNode;
}

// Keep in sync with `server/library/agent-integrations.ts`. Display-only —
// the daemon decides which ids are actually installed.
const AGENT_DISPLAY: AgentDisplay[] = [
  { id: "claude-code", label: "Claude Code", icon: <Sparkles size={14} color="currentColor" /> },
  { id: "codex", label: "Codex", icon: <Bot size={14} color="currentColor" /> },
  { id: "opencode", label: "OpenCode", icon: <SquareTerminal size={14} color="currentColor" /> },
  { id: "cursor", label: "Cursor", icon: <MousePointerClick size={14} color="currentColor" /> },
  { id: "amp", label: "Amp", icon: <Zap size={14} color="currentColor" /> },
  { id: "gemini", label: "Gemini", icon: <Sparkle size={14} color="currentColor" /> },
  { id: "qwen", label: "Qwen", icon: <Braces size={14} color="currentColor" /> },
  { id: "copilot", label: "Copilot", icon: <Github size={14} color="currentColor" /> },
  { id: "droid", label: "Droid", icon: <Box size={14} color="currentColor" /> },
  { id: "hermes", label: "Hermes", icon: <Feather size={14} color="currentColor" /> },
  { id: "crush", label: "Crush", icon: <Hammer size={14} color="currentColor" /> },
  { id: "auggie", label: "Auggie", icon: <CircuitBoard size={14} color="currentColor" /> },
  { id: "goose", label: "Goose", icon: <Compass size={14} color="currentColor" /> },
  { id: "kimi", label: "Kimi", icon: <Flame size={14} color="currentColor" /> },
  { id: "kilocode", label: "Kilocode", icon: <Gauge size={14} color="currentColor" /> },
  { id: "kiro", label: "Kiro", icon: <Rocket size={14} color="currentColor" /> },
  { id: "rovodev", label: "Rovo Dev", icon: <Anchor size={14} color="currentColor" /> },
  { id: "cline", label: "Cline", icon: <Terminal size={14} color="currentColor" /> },
  { id: "continue", label: "Continue", icon: <Waves size={14} color="currentColor" /> },
  { id: "codebuff", label: "Codebuff", icon: <Cpu size={14} color="currentColor" /> },
  { id: "vibe", label: "Vibe", icon: <Sparkle size={14} color="currentColor" /> },
  { id: "pi", label: "Pi", icon: <Wrench size={14} color="currentColor" /> },
  { id: "autohand", label: "Autohand", icon: <Bot size={14} color="currentColor" /> },
  { id: "forge", label: "Forge", icon: <Hammer size={14} color="currentColor" /> },
];

interface SyncTargetsPickerProps {
  transport: McpTransport;
  value: LibrarySyncTarget[];
  onChange: (next: LibrarySyncTarget[]) => void;
  /** When `skill`, we render even agents whose MCP transport list is empty
   *  (they only get a skill folder). When `mcp`, those are hidden. */
  surface?: "mcp" | "skill";
}

/**
 * Chips for each agent CLI the user has installed. Non-installed tools are
 * hidden entirely (per user ask — "mostrar apenas os ativados na máquina").
 * For the MCP surface we also hide agents without an MCP adapter.
 */
export function SyncTargetsPicker({
  transport,
  value,
  onChange,
  surface = "mcp",
}: SyncTargetsPickerProps) {
  const installed = useInstalledAgents();
  const installedIds = installed.data?.installedIds;

  const toggle = (target: LibrarySyncTarget) => {
    if (value.includes(target)) onChange(value.filter((t) => t !== target));
    else onChange([...value, target]);
  };

  const visible = AGENT_DISPLAY.filter((a) => {
    // When we don't yet know what's installed, render everyone so the UI
    // isn't empty on first paint. Refines once the query resolves.
    if (installedIds && !installedIds.has(a.id)) return false;
    if (surface === "mcp") {
      // Hide agents without an MCP adapter on the MCP surface.
      const transports = TRANSPORT_BY_TARGET[a.id];
      if (!transports || transports.length === 0) return false;
    }
    return true;
  });

  const anyTransportDisabled =
    surface === "mcp" && visible.some((a) => !TRANSPORT_BY_TARGET[a.id].includes(transport));

  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>Sync to agents</Text>
      {installed.isLoading && !installed.data ? (
        <Text style={styles.hint}>Detecting installed agents…</Text>
      ) : null}
      {visible.length === 0 && !installed.isLoading ? (
        <Text style={styles.hint}>
          No supported agents detected on PATH. Install one and try again.
        </Text>
      ) : null}
      <View style={styles.row}>
        {visible.map((a) => (
          <TargetChip
            key={a.id}
            target={a.id}
            label={a.label}
            icon={a.icon}
            transport={transport}
            surface={surface}
            active={value.includes(a.id)}
            onPress={() => toggle(a.id)}
          />
        ))}
      </View>
      {anyTransportDisabled ? (
        <Text style={styles.hint}>
          Some agents don't support {transport.toUpperCase()} servers and are disabled.
        </Text>
      ) : null}
    </View>
  );
}

function TargetChip({
  target,
  label,
  icon,
  transport,
  surface,
  active,
  onPress,
}: {
  target: LibrarySyncTarget;
  label: string;
  icon: ReactNode;
  transport: McpTransport;
  surface: "mcp" | "skill";
  active: boolean;
  onPress: () => void;
}) {
  // Skills don't care about transport — every agent gets a folder.
  const supported =
    surface === "skill" ? true : (TRANSPORT_BY_TARGET[target] ?? []).includes(transport);
  return (
    <Pressable
      onPress={supported ? onPress : undefined}
      style={({ hovered, pressed }) => [
        styles.chip,
        active && supported && styles.chipActive,
        !supported && styles.chipDisabled,
        supported && !active && hovered && styles.chipHovered,
        supported && pressed && styles.chipPressed,
      ]}
      accessibilityRole="button"
      accessibilityState={{ selected: active, disabled: !supported }}
    >
      {icon}
      <Text style={[styles.chipLabel, active && supported && styles.chipLabelActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  wrap: {
    gap: theme.spacing[2],
  },
  label: {
    fontSize: theme.fontSize.xs,
    fontWeight: "600" as const,
    color: theme.colors.foreground,
  },
  row: {
    flexDirection: "row",
    gap: theme.spacing[2],
    flexWrap: "wrap" as const,
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: 8,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    color: theme.colors.foregroundMuted,
  },
  chipHovered: {
    backgroundColor: theme.colors.surface2,
  },
  chipPressed: {
    backgroundColor: theme.colors.surface3,
  },
  chipActive: {
    borderColor: theme.colors.accent,
    backgroundColor: theme.colors.surface2,
    color: theme.colors.accent,
  },
  chipDisabled: {
    opacity: 0.4,
  },
  chipLabel: {
    fontSize: theme.fontSize.sm,
    fontWeight: "500" as const,
    color: theme.colors.foreground,
  },
  chipLabelActive: {
    color: theme.colors.accent,
    fontWeight: "600" as const,
  },
  hint: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
}));
