import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  TeamBindingSummary,
  TeamEventPayload,
  TeamSummary,
} from "@getpaseo/protocol/messages";
import { useFetchQuery } from "@/data/query";
import { useHostFeatureMap } from "@/runtime/host-features";
import { getHostRuntimeStore, useHostRuntimeClient, useHosts } from "@/runtime/host-runtime";
import type { PendingTeamMessage } from "./chat-model";

const TEAM_POLL_MS = 3_000;
const TEAM_LIST_POLL_MS = 10_000;

export interface HostTeam extends TeamSummary {
  serverId: string;
  serverName: string;
}

/** Hosts whose daemon runs the team runtime. */
export function useTeamHosts(): { serverId: string; label: string }[] {
  const hosts = useHosts();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const supported = useHostFeatureMap(serverIds, "teams");
  return useMemo(
    () => hosts.filter((host) => supported.get(host.serverId) === true),
    [hosts, supported],
  );
}

export function useTeamList(): {
  teams: HostTeam[];
  isLoading: boolean;
  error: Error | null;
  refetch: () => void;
} {
  const hosts = useTeamHosts();
  const query = useFetchQuery({
    queryKey: ["teams", hosts.map((host) => host.serverId).join("|")],
    queryFn: async () => {
      const runtime = getHostRuntimeStore();
      const perHost = await Promise.all(
        hosts.map(async (host) => {
          const client = runtime.getClient(host.serverId);
          if (!client) return [];
          const { teams } = await client.listTeams();
          return teams.map(
            (team): HostTeam =>
              Object.assign(team, { serverId: host.serverId, serverName: host.label }),
          );
        }),
      );
      return perHost
        .flat()
        .sort((a, b) => (b.lastEventAt ?? b.createdAt).localeCompare(a.lastEventAt ?? a.createdAt));
    },
    dataShape: "list",
    staleTimeMs: 5_000,
    refetchInterval: TEAM_LIST_POLL_MS,
  });
  return {
    teams: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error,
    refetch: () => {
      void query.refetch();
    },
  };
}

export type TeamChatState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      team: TeamSummary;
      events: TeamEventPayload[];
      bindings: TeamBindingSummary[];
    };

/** The team's event log, polled with `afterCommit` while mounted, plus the person's composer. */
export function useTeamChat(input: { serverId: string; teamId: string }): {
  state: TeamChatState;
  pending: PendingTeamMessage[];
  sendError: string | null;
  send: (text: string) => Promise<boolean>;
} {
  const client = useHostRuntimeClient(input.serverId);
  const [state, setState] = useState<TeamChatState>({ status: "loading" });
  const [pending, setPending] = useState<PendingTeamMessage[]>([]);
  const [sendError, setSendError] = useState<string | null>(null);
  const commitRef = useRef<number | undefined>(undefined);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const teamKey = `${input.serverId}:${input.teamId}`;
  const teamKeyRef = useRef(teamKey);

  const load = useCallback(async (): Promise<void> => {
    if (!client) return;
    const key = teamKey;
    try {
      const response = await client.getTeamEvents({
        teamId: input.teamId,
        afterCommit: commitRef.current,
      });
      // A reply for the team the person just left must not land in the new one.
      if (teamKeyRef.current !== key) return;
      commitRef.current = response.commit;
      setState((current) => ({
        status: "ready",
        team: response.team,
        bindings: response.bindings,
        events:
          current.status === "ready" ? [...current.events, ...response.events] : response.events,
      }));
    } catch (error) {
      if (teamKeyRef.current !== key) return;
      setState((current) =>
        current.status === "ready"
          ? current
          : { status: "error", message: error instanceof Error ? error.message : String(error) },
      );
    }
  }, [client, input.teamId, teamKey]);

  // One request at a time, so two overlapping polls never append the same events twice.
  const fetchNew = useCallback((): Promise<void> => {
    const previous = inFlightRef.current;
    const next = (async () => {
      await previous;
      await load();
    })();
    inFlightRef.current = next;
    return next;
  }, [load]);

  useEffect(() => {
    teamKeyRef.current = teamKey;
    commitRef.current = undefined;
    setState({ status: "loading" });
    setPending([]);
    setSendError(null);
  }, [teamKey]);

  useEffect(() => {
    void fetchNew();
    const timer = setInterval(() => void fetchNew(), TEAM_POLL_MS);
    return () => clearInterval(timer);
  }, [fetchNew]);

  const send = useCallback(
    async (text: string): Promise<boolean> => {
      const trimmed = text.trim();
      if (!trimmed || !client) return false;
      const message = { id: `${Date.now()}`, text: trimmed, at: new Date().toISOString() };
      setPending((current) => [...current, message]);
      setSendError(null);
      try {
        const response = await client.sendTeamMessage({ teamId: input.teamId, text: trimmed });
        if (!response.ok) throw new Error(response.error ?? "Message was not delivered");
        await fetchNew();
        return true;
      } catch (error) {
        setSendError(error instanceof Error ? error.message : String(error));
        return false;
      } finally {
        setPending((current) => current.filter((entry) => entry.id !== message.id));
      }
    },
    [client, fetchNew, input.teamId],
  );

  return { state, pending, sendError, send };
}
