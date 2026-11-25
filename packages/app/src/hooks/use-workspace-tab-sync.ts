import { useCallback, useLayoutEffect, useRef, useState } from "react";
import {
  applyWorkspaceTabLayoutOperations,
  syncsWorkspaceSplits,
  type WorkspaceTabLayoutOperation,
  type WorkspaceTabLayoutState,
} from "@getpaseo/protocol/workspace-tab-layout";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { supportsDesktopPaneSplits } from "@/constants/layout";
import { getIsElectron } from "@/constants/platform";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import { useToast } from "@/contexts/toast-context";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostFeature } from "@/runtime/host-features";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { diffWorkspaceTabLayout } from "@/stores/workspace-tab-sync-layout";

const COALESCE_MS = 50;

function createWorkspaceTabSync(input: {
  client: DaemonClient;
  workspaceId: string;
  workspaceKey: string;
  onReady: (ready: boolean) => void;
  onError: (error: unknown) => void;
}) {
  const store = useWorkspaceLayoutStore;
  const { client, workspaceId, workspaceKey } = input;
  let remote: WorkspaceTabLayoutState | undefined;
  let observed: WorkspaceTabLayoutState | undefined;
  let pending: WorkspaceTabLayoutOperation[] = [];
  let sending: WorkspaceTabLayoutOperation[] = [];
  let connected = false;
  let desktop = false;
  let syncSplits = false;
  let initialized = false;
  let applying = false;
  let busy = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const suppressedTerminals = new Set<string>();

  function renderRemote() {
    if (!remote || stopped) return;
    const projected = applyWorkspaceTabLayoutOperations(
      remote,
      [...sending, ...pending],
      syncSplits,
    );
    const local = store.getState().projectSharedTabLayout(workspaceKey, syncSplits);
    if (
      JSON.stringify(local) ===
      JSON.stringify({ ...projected, split: syncSplits ? projected.split : undefined })
    ) {
      return;
    }
    applying = true;
    try {
      store.getState().mergeSharedTabLayout(workspaceKey, projected, syncSplits);
    } finally {
      applying = false;
    }
  }

  function accept(state: WorkspaceTabLayoutState) {
    if (remote && state.revision < remote.revision) return;
    const terminals = new Set(
      state.tabs.flatMap((tab) => (tab.target.kind === "terminal" ? [tab.target.terminalId] : [])),
    );
    for (const tab of remote?.tabs ?? []) {
      if (tab.target.kind === "terminal" && !terminals.has(tab.target.terminalId)) {
        suppressedTerminals.add(tab.target.terminalId);
      }
    }
    for (const terminalId of terminals) suppressedTerminals.delete(terminalId);
    remote = state;
  }

  function schedule() {
    if (timer || busy || !connected || stopped || (initialized && pending.length === 0)) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, COALESCE_MS);
  }

  async function flush() {
    if (busy || !connected || stopped) return;
    const seed = initialized
      ? undefined
      : store.getState().projectSharedTabLayout(workspaceKey, syncSplits);
    // A handshake lends the daemon the local cache only if no client has seeded it yet.
    // An edit made after this point is always sent as an operation.
    const operations = initialized || remote ? pending.splice(0, 1024) : [];
    const attemptedInitialization = !initialized;
    if (attemptedInitialization && !remote) pending = [];
    busy = true;
    sending = operations;
    let failed = false;
    try {
      const response = await client.applyWorkspaceTabLayout({
        workspaceId,
        desktop,
        seed,
        operations,
      });
      if (stopped) return;
      accept(response);
      if (observed && observed.revision > response.revision) accept(observed);
      initialized = true;
    } catch (error) {
      if (stopped) return;
      failed = true;
      // Fetch the current revision after an ambiguous error. Replaying a move can overwrite
      // a later edit from another client if the original request succeeded before disconnecting.
      initialized = false;
      if (connected) input.onError(error);
    } finally {
      busy = false;
      sending = [];
      if (!stopped) {
        renderRemote();
        if (initialized) ensureSplit();
        input.onReady(initialized || failed);
        if (!failed || !attemptedInitialization) schedule();
      }
    }
  }

  function ensureSplit() {
    if (
      !syncSplits ||
      remote?.split ||
      sending.some((op) => op.kind === "split") ||
      pending.some((op) => op.kind === "split")
    )
      return;
    const { split } = store.getState().projectSharedTabLayout(workspaceKey, true);
    if (split) pending.push({ kind: "split", split, ifMissing: true });
  }

  const unsubscribe = store.subscribe((next, previous) => {
    if (
      applying ||
      (next.layoutByWorkspace[workspaceKey] === previous.layoutByWorkspace[workspaceKey] &&
        next.hiddenAgentIdsByWorkspace[workspaceKey] ===
          previous.hiddenAgentIdsByWorkspace[workspaceKey] &&
        next.pinnedAgentIdsByWorkspace[workspaceKey] ===
          previous.pinnedAgentIdsByWorkspace[workspaceKey] &&
        next.splitSizesByWorkspace[workspaceKey] === previous.splitSizesByWorkspace[workspaceKey] &&
        next.explorerSidebarPaneIdByWorkspace[workspaceKey] ===
          previous.explorerSidebarPaneIdByWorkspace[workspaceKey])
    ) {
      return;
    }
    if (!initialized && !busy && !remote) return;
    pending.push(
      ...diffWorkspaceTabLayout(
        previous.projectSharedTabLayout(workspaceKey, syncSplits, previous),
        next.projectSharedTabLayout(workspaceKey, syncSplits),
      ),
    );
    schedule();
  });

  return {
    configure(next: { connected: boolean; desktop: boolean; syncSplits: boolean }) {
      const splitModeChanged = syncSplits !== next.syncSplits;
      const reconnected = !connected && next.connected;
      connected = next.connected;
      desktop = next.desktop;
      syncSplits = next.syncSplits;
      if (reconnected) {
        initialized = false;
        observed = undefined;
      }
      if (!syncSplits) pending = pending.filter((op) => op.kind !== "split");
      if (splitModeChanged && initialized) {
        renderRemote();
        ensureSplit();
      }
      schedule();
    },
    observe(state: WorkspaceTabLayoutState | undefined) {
      if (!state || (observed && observed.revision >= state.revision)) return;
      observed = state;
      if (!initialized || (remote && remote.revision >= state.revision)) return;
      accept(state);
      renderRemote();
    },
    allowsAutoOpenTerminal(terminalId: string) {
      return !suppressedTerminals.has(terminalId);
    },
    dispose() {
      if (timer) clearTimeout(timer);
      // A tab gesture may also switch workspace routes. Send its batch before losing the observer.
      if (connected && initialized && pending.length > 0) {
        void client
          .applyWorkspaceTabLayout({ workspaceId, desktop, operations: pending })
          .catch(input.onError);
      }
      stopped = true;
      unsubscribe();
    },
  };
}

export function useWorkspaceTabSync(input: {
  serverId: string;
  workspaceId: string;
  workspaceKey: string | null;
  client: DaemonClient | null;
  connected: boolean;
  hydrated: boolean;
  compact: boolean;
  workspace: WorkspaceDescriptor | null;
}) {
  const { serverId, workspaceId, workspaceKey, client, connected, hydrated, compact, workspace } =
    input;
  const desktop = getIsElectron() || (supportsDesktopPaneSplits() && !compact);
  const canSeed = Boolean(workspace);
  const state = workspace?.tabLayout;
  // COMPAT(workspaceTabSync): older daemons continue to use the device's local layout.
  const enabled = useHostFeature(serverId, "workspaceTabSync");
  const { config } = useDaemonConfig(enabled ? serverId : null);
  const syncSplits = syncsWorkspaceSplits(config?.workspaceSplitSync ?? "off", desktop);
  const toast = useToast();
  const onError = useRef(toast.error);
  const controller = useRef<ReturnType<typeof createWorkspaceTabSync> | null>(null);
  const [readyWorkspace, setReadyWorkspace] = useState<string | null>(null);

  useLayoutEffect(() => {
    onError.current = toast.error;
  }, [toast.error]);

  useLayoutEffect(() => {
    if (!enabled || !client || !hydrated || !workspaceKey || !canSeed) return;
    setReadyWorkspace(null);
    const connection = createWorkspaceTabSync({
      client,
      workspaceId,
      workspaceKey,
      onReady: (ready) => setReadyWorkspace(ready ? workspaceKey : null),
      onError: (error) => onError.current(error instanceof Error ? error.message : String(error)),
    });
    controller.current = connection;
    return () => {
      connection.dispose();
      controller.current = null;
    };
  }, [canSeed, client, enabled, hydrated, workspaceId, workspaceKey]);

  useLayoutEffect(() => {
    controller.current?.configure({ connected, desktop, syncSplits });
    controller.current?.observe(state);
  }, [canSeed, client, enabled, hydrated, connected, desktop, state, syncSplits, workspaceKey]);

  const allowsAutoOpenTerminal = useCallback(
    (terminalId: string) => controller.current?.allowsAutoOpenTerminal(terminalId) ?? true,
    [],
  );
  return {
    ready: hydrated && (!enabled || !connected || readyWorkspace === workspaceKey),
    allowsAutoOpenTerminal,
  };
}
