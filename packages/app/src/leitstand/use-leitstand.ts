import { useCallback, useEffect, useMemo, useState } from "react";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { useSidebarWorkspaceEntries } from "@/hooks/use-sidebar-workspace-entries";
import { useSidebarWorkspacesList } from "@/hooks/use-sidebar-workspaces-list";
import { useSchedules } from "@/hooks/use-schedules";
import { useSessionStore, type Agent, type WorkspaceDescriptor } from "@/stores/session-store";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-identity";
import {
  buildLeitstandInbox,
  snoozeUntil,
  type LeitstandInbox,
  type SnoozeOption,
} from "./inbox-model";
import { useLeitstandPreferencesStore } from "./preferences-store";
import {
  buildLeitstandSession,
  groupRootAgentsByWorkspace,
  resolveScheduleProject,
  type LeitstandSchedule,
  type LeitstandSession,
} from "./session-model";

// The Leitstand spans every host, whatever the sidebar is pinned to.
const ALL_HOSTS: string[] = [];
const EMPTY_SCHEDULES: LeitstandSchedule[] = [];

interface HostSource {
  serverId: string;
  agents: Map<string, Agent> | undefined;
  workspaces: Map<string, WorkspaceDescriptor> | undefined;
}

function areHostSourcesEqual(left: readonly HostSource[], right: readonly HostSource[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (source, index) =>
        source.serverId === right[index]?.serverId &&
        source.agents === right[index]?.agents &&
        source.workspaces === right[index]?.workspaces,
    )
  );
}

export interface LeitstandProject {
  viewKey: string;
  name: string;
}

export interface LeitstandSessionsState {
  sessions: LeitstandSession[];
  projects: LeitstandProject[];
  hasProjects: boolean;
  isInitialLoad: boolean;
  runningAgentCount: number;
}

/** Every live workspace across hosts, as Leitstand sessions with their agents and PRs. */
export function useLeitstandSessions(): LeitstandSessionsState {
  const list = useSidebarWorkspacesList({ hostFilters: ALL_HOSTS });
  const entries = useSidebarWorkspaceEntries(list.workspacePlacements);
  const serverIds = useMemo(
    () => [...new Set(list.workspacePlacements.map((placement) => placement.serverId))],
    [list.workspacePlacements],
  );
  const sources = useStoreWithEqualityFn(
    useSessionStore,
    (state) =>
      serverIds.map((serverId) => ({
        serverId,
        agents: state.sessions[serverId]?.agents,
        workspaces: state.sessions[serverId]?.workspaces,
      })),
    areHostSourcesEqual,
  );

  const sessions = useMemo(() => {
    const sourceByServer = new Map(sources.map((source) => [source.serverId, source]));
    const agentsByServer = new Map(
      sources.map((source) => [
        source.serverId,
        groupRootAgentsByWorkspace(source.agents?.values() ?? []),
      ]),
    );
    const result: LeitstandSession[] = [];
    for (const entry of entries.values()) {
      if (entry.archivingAt) continue;
      const workspaces = sourceByServer.get(entry.serverId)?.workspaces;
      const workspaceKey = resolveWorkspaceMapKeyByIdentity({
        workspaces,
        workspaceId: entry.workspaceId,
      });
      const workspace = workspaceKey ? workspaces?.get(workspaceKey) : undefined;
      result.push(
        buildLeitstandSession({
          entry,
          githubRuntime: workspace?.githubRuntime,
          agents: agentsByServer.get(entry.serverId)?.get(entry.workspaceId) ?? [],
          topic: workspace?.topic ?? null,
          doneAt: workspace?.doneAt ?? null,
        }),
      );
    }
    return result;
  }, [entries, sources]);

  const projects = useMemo(
    () => list.projects.map((project) => ({ viewKey: project.viewKey, name: project.projectName })),
    [list.projects],
  );

  const runningAgentCount = useMemo(
    () =>
      sessions.reduce(
        (count, session) =>
          count + session.agents.filter((agent) => agent.bucket === "running").length,
        0,
      ),
    [sessions],
  );

  return {
    sessions,
    projects,
    hasProjects: list.projects.length > 0,
    isInitialLoad: list.isInitialLoad,
    runningAgentCount,
  };
}

/** Schedules across connected hosts, placed into the session project they work in. */
export function useLeitstandSchedules(sessions: readonly LeitstandSession[]): LeitstandSchedule[] {
  const { loadState } = useSchedules();
  const data = loadState.status === "loaded" ? loadState.data : null;
  return useMemo(() => {
    if (!data) return EMPTY_SCHEDULES;
    return data.map((schedule) => ({
      key: `${schedule.serverId}:${schedule.id}`,
      serverId: schedule.serverId,
      schedule,
      ...resolveScheduleProject({ serverId: schedule.serverId, schedule }, sessions),
    }));
  }, [data, sessions]);
}

export interface SnoozableInbox extends LeitstandInbox {
  snooze: (itemId: string, option: SnoozeOption) => void;
}

/** The inbox over the given data, minus this device's active snoozes; wakes when one runs out. */
export function useSnoozableInbox(
  sessions: readonly LeitstandSession[],
  schedules: readonly LeitstandSchedule[],
): SnoozableInbox {
  const snoozedUntil = useLeitstandPreferencesStore((state) => state.snoozedUntil);
  const storeSnooze = useLeitstandPreferencesStore((state) => state.snooze);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const inbox = useMemo(
    () => buildLeitstandInbox({ sessions, schedules, snoozedUntil, nowMs }),
    [nowMs, schedules, sessions, snoozedUntil],
  );

  useEffect(() => {
    if (inbox.nextWakeAt === null) return undefined;
    const timer = setTimeout(
      () => setNowMs(Date.now()),
      Math.max(0, inbox.nextWakeAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [inbox.nextWakeAt]);

  const snooze = useCallback(
    (itemId: string, option: SnoozeOption) => {
      const now = new Date();
      storeSnooze(itemId, snoozeUntil(option, now).getTime(), now.getTime());
      setNowMs(now.getTime());
    },
    [storeSnooze],
  );

  return { ...inbox, snooze };
}

/** "Braucht dich" for any surface: the Leitstand inbox, derived from live data and snoozes. */
export function useLeitstandInbox(): SnoozableInbox {
  const { sessions } = useLeitstandSessions();
  const schedules = useLeitstandSchedules(sessions);
  return useSnoozableInbox(sessions, schedules);
}
