import type { ComponentType } from "react";
import { Bot, Brain, Eye, Pencil, Search, SquareTerminal, Wrench } from "lucide-react-native";
import type { ToolCallDetail } from "@server/server/agent/agent-sdk-types";

export type ToolCallIconComponent = ComponentType<{ size?: number; color?: string }>;

const TOOL_DETAIL_ICONS: Record<ToolCallDetail["type"], ToolCallIconComponent> = {
  shell: SquareTerminal,
  read: Eye,
  edit: Pencil,
  write: Pencil,
  search: Search,
  unknown: Wrench,
};

export function resolveToolCallIcon(toolName: string, detail?: ToolCallDetail): ToolCallIconComponent {
  const lowerName = toolName.trim().toLowerCase();

  // Thoughts are rendered through ToolCall with unknown detail payloads.
  if (lowerName === "thinking" && (!detail || detail.type === "unknown")) {
    return Brain;
  }

  if (detail) {
    return TOOL_DETAIL_ICONS[detail.type];
  }

  if (lowerName === "task") {
    return Bot;
  }
  return Wrench;
}
