import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import { useStableEvent } from "@/hooks/use-stable-event";
import {
  openWorkspaceAgentBrowser,
  rememberWorkspaceClassicBrowser,
} from "@/workspace-tabs/agent-browser";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";

export function useAgentBrowser(
  serverId: string,
  workspaceId: string,
  workspaceKey: string | null,
) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const local = useIsLocalDaemon(serverId);
  const supported = useHostFeature(serverId, "workspaceAgentBrowser");
  const pending = useRef(new Set<string>());
  const [loading, setLoading] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<{ workspaceKey: string; message: string } | null>(null);
  useEffect(() => {
    if (!workspaceKey) return;
    rememberWorkspaceClassicBrowser(workspaceKey);
    return useWorkspaceLayoutStore.subscribe(() => rememberWorkspaceClassicBrowser(workspaceKey));
  }, [workspaceKey]);
  const open = useStableEvent(async () => {
    if (!workspaceKey || pending.current.has(workspaceKey)) return;
    setError(null);
    const fail = (message: string) => setError({ workspaceKey, message });
    if (!local) return fail(t("workspace.browser.agentBrowser.localOnly"));
    if (!supported) return fail(t("workspace.browser.agentBrowser.updateHost"));
    if (!client) return fail(t("workspace.browser.agentBrowser.startFailed"));
    pending.current.add(workspaceKey);
    setLoading((current) => new Set(current).add(workspaceKey));
    try {
      const result = await client.openWorkspaceAgentBrowser(workspaceId);
      if (result.error || !result.url) {
        let message = t("workspace.browser.agentBrowser.startFailed");
        if (result.error === "tool_missing")
          message = t("workspace.browser.agentBrowser.toolMissing");
        if (result.error === "version_incompatible")
          message = t("workspace.browser.agentBrowser.updateTool");
        fail(message);
      } else if (!openWorkspaceAgentBrowser(workspaceKey, result.url).ok) {
        fail(t("workspace.browser.placementUnavailable"));
      }
    } catch {
      fail(t("workspace.browser.agentBrowser.startFailed"));
    } finally {
      pending.current.delete(workspaceKey);
      setLoading((current) => {
        const next = new Set(current);
        next.delete(workspaceKey);
        return next;
      });
    }
  });
  return {
    open,
    loading: workspaceKey !== null && loading.has(workspaceKey),
    error: error?.workspaceKey === workspaceKey ? error.message : null,
    dismiss: () => setError(null),
  };
}
