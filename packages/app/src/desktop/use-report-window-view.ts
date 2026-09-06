import { useEffect, useMemo, useRef } from "react";
import { getDesktopHost } from "@/desktop/host";
import { buildWindowViewReport, type WindowViewReport } from "@/desktop/window-view-report";
import { useDesktopWindowViewStore } from "@/stores/desktop-window-view-store";

function reportsEqual(a: WindowViewReport, b: WindowViewReport): boolean {
  return (
    a.visibleAgentIds.length === b.visibleAgentIds.length &&
    a.visibleWorkspaceKeys.length === b.visibleWorkspaceKeys.length &&
    a.visibleAgentIds.every((id, index) => id === b.visibleAgentIds[index]) &&
    a.visibleWorkspaceKeys.every((key, index) => key === b.visibleWorkspaceKeys[index])
  );
}

/**
 * Sends this window's current view (visible agents, visible sidebar workspaces) to the
 * desktop main process, so a notification click or deep link can be routed to the
 * window already showing the target instead of the focused or sending window.
 *
 * `workspace-screen.tsx` and `sidebar-model.tsx` publish into
 * `useDesktopWindowViewStore` independently; this is the one place that reads both
 * slices and sends. `buildWindowViewReport` sorts and dedupes, so an unchanged
 * underlying state always produces a deep-equal report — the send is skipped, because
 * both source maps are rebuilt on nearly every session-store tick and a naive effect
 * would ship the full workspace key list (dozens of entries) on every agent stream tick.
 *
 * No-ops outside Electron, and on an old shell without the `reportView` bridge method.
 */
export function useReportWindowView(): void {
  const visibleAgentIdsByWorkspace = useDesktopWindowViewStore(
    (state) => state.visibleAgentIdsByWorkspace,
  );
  const visibleWorkspaceKeys = useDesktopWindowViewStore((state) => state.visibleWorkspaceKeys);
  // Only the focused workspace screen ever reports non-empty ids (see the store's
  // doc comment), so unioning every mounted workspace's entry is always safe.
  const visibleAgentIds = useMemo(
    () => [...visibleAgentIdsByWorkspace.values()].flat(),
    [visibleAgentIdsByWorkspace],
  );
  const lastSentRef = useRef<WindowViewReport | null>(null);

  useEffect(() => {
    const reportView = getDesktopHost()?.window?.reportView;
    if (!reportView) {
      return;
    }
    const report = buildWindowViewReport({ visibleAgentIds, visibleWorkspaceKeys });
    if (lastSentRef.current && reportsEqual(lastSentRef.current, report)) {
      return;
    }
    lastSentRef.current = report;
    void reportView(report);
  }, [visibleAgentIds, visibleWorkspaceKeys]);
}

export function WindowViewReporter(): null {
  useReportWindowView();
  return null;
}
