import type { AgentAttentionReason } from "@getpaseo/protocol/agent-attention-notification";
import type { AppSettings } from "@/hooks/use-settings/storage";
export function shouldNotifyTask(input: {
  reason: AgentAttentionReason;
  preferences: AppSettings["taskNotifications"];
  away: boolean;
  native: boolean;
  visible: boolean;
  backgroundPush: boolean;
}): boolean {
  const enabled = {
    finished: input.preferences.completed,
    error: input.preferences.failed,
    permission: input.preferences.waiting,
  }[input.reason];
  if (!enabled || (!input.away && !input.preferences.whileViewing)) return false;
  return !(input.native && !input.visible && input.backgroundPush);
}
