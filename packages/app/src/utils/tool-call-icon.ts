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
};

export function resolveToolCallIcon(toolName: string, detail?: ToolCallDetail): ToolCallIconComponent {
  if (detail) {
    return TOOL_DETAIL_ICONS[detail.type];
  }

  const lowerName = toolName.trim().toLowerCase();
  if (lowerName === "task") {
    return Bot;
  }
  if (lowerName === "thinking") {
    return Brain;
  }
  return Wrench;
}
