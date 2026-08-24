import type { AgentProviderNotice } from "@getpaseo/protocol/agent-types";
import type { ToastApi } from "@/components/toast-host";

export function showProviderNoticeToast(
  toast: ToastApi,
  notice: AgentProviderNotice | null | undefined,
): void {
  if (!notice) {
    return;
  }
  if (notice.type === "error") {
    toast.error(notice.message);
    return;
  }
  toast.show(notice.message, {
    variant: notice.type,
    durationMs: notice.type === "warning" ? 5000 : undefined,
  });
}
