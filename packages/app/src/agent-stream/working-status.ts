import type { StreamItem } from "@/types/stream";
import type { TurnPresentation } from "@/timeline/turn-liveness";
import type { TFunction } from "i18next";

export function buildWorkingLabel(
  t: TFunction,
  turn: TurnPresentation,
  needsInput: boolean,
  tool: string | null,
  subagentCount: number,
): string {
  const labels: string[] = [];
  if (needsInput) labels.push(t("sidebar.status.needsInput"));
  else if (turn.isCancelling) labels.push(t("composer.cancel.cancelingAgent"));
  else if (turn.isActive) {
    labels.push(t("sidebar.status.running"));
    if (tool) labels.push(tool);
  }
  if (subagentCount > 0) {
    labels.push(
      `${t("subagents.title")}: ${t("subagents.pillLabelWorking", { count: subagentCount })}`,
    );
  }
  return labels.join(" · ");
}

export function resolveWorkingTool(
  items: readonly StreamItem[],
  turn: TurnPresentation,
): string | null {
  if (!turn.isActive || turn.isCancelling) return null;
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index]!;
    if (item.kind === "user_message" && !turn.turnId && !turn.startedAt) break;
    if (turn.turnId && item.turnId && item.turnId !== turn.turnId) continue;
    if (turn.startedAt && item.timestamp < turn.startedAt) continue;
    if (item.kind !== "tool_call") continue;
    const { payload } = item;
    if (payload.source === "agent" && payload.data.status === "running") {
      return payload.data.detail.type === "shell" ? "Shell" : payload.data.name;
    }
    if (payload.source === "orchestrator" && payload.data.status === "executing") {
      return payload.data.toolName;
    }
  }
  return null;
}
