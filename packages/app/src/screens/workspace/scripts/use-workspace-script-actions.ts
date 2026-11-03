import { useCallback, useEffect, useMemo, useRef } from "react";
import * as Clipboard from "expo-clipboard";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { useSessionStore } from "@/stores/session-store";
import { useHostRuntimeSnapshot } from "@/runtime/host-runtime";
import { useToast } from "@/contexts/toast-context";
import {
  resolveWorkspaceScriptLink,
  type WorkspaceScriptLinkKind,
  type WorkspaceScriptLinkTarget,
} from "@/utils/workspace-script-links";
import { useWorkspaceServiceRoutePreferencesStore } from "@/workspace-service-routes/store";

type WorkspaceScript = WorkspaceDescriptor["scripts"][number];

export interface WorkspaceScriptLinks {
  /** The URL this host's route preference picks, or null when the script serves none. */
  selected: WorkspaceScriptLinkTarget | null;
  targets: WorkspaceScriptLinkTarget[];
}

export interface WorkspaceScriptActions {
  start: (scriptName: string) => void;
  stop: (scriptName: string) => void;
  /** Stops the script, then starts it again once the daemon reports it stopped. */
  restart: (scriptName: string) => void;
  copyUrl: (target: WorkspaceScriptLinkTarget) => void;
  selectRoute: (kind: WorkspaceScriptLinkKind) => void;
  resolveLinks: (script: WorkspaceScript) => WorkspaceScriptLinks;
  isStartPending: boolean;
  isStopPending: boolean;
}

export interface UseWorkspaceScriptActionsInput {
  serverId: string;
  workspaceId: string;
  scripts: WorkspaceDescriptor["scripts"];
  onScriptTerminalStarted?: (terminalId: string) => void;
}

/**
 * Run, stop, restart and URL handling for a workspace's scripts, shared by every surface that
 * lists them.
 *
 * A restart outlives the press that asked for it — the second half waits for the daemon to
 * report the script stopped — so mount this with whatever owns the menu, not inside a menu page
 * that unmounts when the menu closes.
 */
export function useWorkspaceScriptActions({
  serverId,
  workspaceId,
  scripts,
  onScriptTerminalStarted,
}: UseWorkspaceScriptActionsInput): WorkspaceScriptActions {
  const { t } = useTranslation();
  const toast = useToast();
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const activeConnection = useHostRuntimeSnapshot(serverId)?.activeConnection ?? null;
  const preferredRouteKind = useWorkspaceServiceRoutePreferencesStore(
    (state) => state.byServerId[serverId] ?? null,
  );
  const setPreferredRoute = useWorkspaceServiceRoutePreferencesStore(
    (state) => state.setPreferredRoute,
  );
  const pendingRestartRef = useRef<Set<string>>(new Set());

  const startScriptMutation = useMutation({
    mutationFn: async (scriptName: string) => {
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      const result = await client.startWorkspaceScript(workspaceId, scriptName);
      if (result.error) {
        throw new Error(result.error);
      }
      return result;
    },
    onError: (error, scriptName) => {
      toast.show(
        error instanceof Error
          ? error.message
          : t("workspace.scripts.states.startFailed", { scriptName }),
        {
          variant: "error",
        },
      );
    },
    onSuccess: (result) => {
      if (result.terminalId) {
        onScriptTerminalStarted?.(result.terminalId);
      }
    },
  });
  const startScript = startScriptMutation.mutate;

  const stopScriptMutation = useMutation({
    mutationFn: async (scriptName: string) => {
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      const terminalId = scripts.find((s) => s.scriptName === scriptName)?.terminalId;
      if (!terminalId) {
        throw new Error(t("workspace.scripts.states.stopFailed", { scriptName }));
      }
      const result = await client.killTerminal(terminalId);
      if (!result.success) {
        throw new Error(t("workspace.scripts.states.stopFailed", { scriptName }));
      }
    },
    onError: (error, scriptName) => {
      pendingRestartRef.current.delete(scriptName);
      toast.show(
        error instanceof Error
          ? error.message
          : t("workspace.scripts.states.stopFailed", { scriptName }),
        {
          variant: "error",
        },
      );
    },
  });
  const stopScript = stopScriptMutation.mutate;

  // Restart = kill the script terminal, then start again once the daemon
  // reports the script as stopped (it tears the runtime entry down on exit).
  useEffect(() => {
    const pending = pendingRestartRef.current;
    if (pending.size === 0) return;
    for (const script of scripts) {
      if (!pending.has(script.scriptName) || script.lifecycle === "running") continue;
      pending.delete(script.scriptName);
      startScript(script.scriptName);
    }
  }, [scripts, startScript]);

  const restart = useCallback(
    (scriptName: string) => {
      pendingRestartRef.current.add(scriptName);
      stopScript(scriptName);
    },
    [stopScript],
  );

  const copyUrl = useCallback(
    (target: WorkspaceScriptLinkTarget) => {
      void Clipboard.setStringAsync(target.url);
      toast.copied(target.label);
    },
    [toast],
  );

  const selectRoute = useCallback(
    (kind: WorkspaceScriptLinkKind) => setPreferredRoute(serverId, kind),
    [serverId, setPreferredRoute],
  );

  const resolveLinks = useCallback(
    (script: WorkspaceScript): WorkspaceScriptLinks => {
      const link = resolveWorkspaceScriptLink({ script, activeConnection });
      const selected =
        link.targets.find((target) => target.kind === preferredRouteKind) ?? link.primary;
      return { selected, targets: link.targets };
    },
    [activeConnection, preferredRouteKind],
  );

  return useMemo(
    () => ({
      start: startScript,
      stop: stopScript,
      restart,
      copyUrl,
      selectRoute,
      resolveLinks,
      isStartPending: startScriptMutation.isPending,
      isStopPending: stopScriptMutation.isPending,
    }),
    [
      startScript,
      stopScript,
      restart,
      copyUrl,
      selectRoute,
      resolveLinks,
      startScriptMutation.isPending,
      stopScriptMutation.isPending,
    ],
  );
}
