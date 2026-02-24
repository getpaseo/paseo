import type { ComponentType } from "react";
import {
  Bot,
  Brain,
  Eye,
  MicVocal,
  Pencil,
  Search,
  Sparkles,
  SquareTerminal,
  Wrench,
} from "lucide-react-native";
import type { ToolCallDetail, ToolCallIconName } from "@server/server/agent/agent-sdk-types";

export type ToolCallIconComponent = ComponentType<{ size?: number; color?: string }>;

const TOOL_DETAIL_ICONS: Record<ToolCallDetail["type"], ToolCallIconComponent> = {
  shell: SquareTerminal,
  read: Eye,
  edit: Pencil,
  write: Pencil,
  search: Search,
  worktree_setup: SquareTerminal,
  sub_agent: Bot,
  plain_text: Wrench,
  unknown: Wrench,
};

const TOOL_ICON_BY_NAME: Record<ToolCallIconName, ToolCallIconComponent> = {
  wrench: Wrench,
  square_terminal: SquareTerminal,
  eye: Eye,
  pencil: Pencil,
  search: Search,
  bot: Bot,
  sparkles: Sparkles,
  brain: Brain,
  mic_vocal: MicVocal,
};

export function resolveToolCallIcon(toolName: string, detail?: ToolCallDetail): ToolCallIconComponent {
  const lowerName = toolName.trim().toLowerCase();

  if (detail?.type === "plain_text" && detail.icon) {
    return TOOL_ICON_BY_NAME[detail.icon];
  }

  // Thoughts are rendered through ToolCall with unknown detail payloads.
  if (lowerName === "thinking" && (!detail || detail.type === "unknown")) {
    return Brain;
  }
  if (lowerName === "speak") {
    return MicVocal;
  }
  if (lowerName === "task") {
    return Bot;
  }

  if (detail) {
    return TOOL_DETAIL_ICONS[detail.type];
  }
  return Wrench;
}
