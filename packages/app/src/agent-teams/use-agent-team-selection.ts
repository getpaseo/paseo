import { useCallback, useMemo, useState } from "react";
import type { AgentTeamSummary } from "@getpaseo/protocol/messages";
import { useFetchQuery } from "@/data/query";
import { useFormPreferences } from "@/hooks/use-form-preferences";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { filterSelectableModels } from "@/provider-selection/model-catalog";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";
import { rememberSelectedTeam, resolveSelectedTeam, setRoleModelOverride } from "./team-selection";

export interface AgentTeamModelOption {
  id: string;
  label: string;
}

export interface AgentTeamSelection {
  teams: AgentTeamSummary[];
  selectedTeam: string | null;
  onSelectTeam: (team: string | null) => void;
  /** Role name -> model for the chat being created. Never persisted; reset when the team changes. */
  roleModelOverrides: Record<string, string>;
  /** Role name -> the selectable models of that role's provider, for the selected team. */
  roleModelOptions: Record<string, AgentTeamModelOption[]>;
  /** Null, or the role's configured model, clears the override. */
  onSetRoleModel: (role: string, model: string | null) => void;
}

const EMPTY_TEAMS: AgentTeamSummary[] = [];
const EMPTY_RECORD: Record<string, never> = {};

/**
 * Teams defined on the host and the remembered choice for it. Returns no teams
 * when the host predates `features.agentTeams`, so the selector stays hidden.
 */
export function useAgentTeamSelection(serverId: string | null): AgentTeamSelection {
  const normalizedServerId = serverId ?? "";
  const client = useHostRuntimeClient(normalizedServerId);
  const supported = useHostFeature(serverId, "agentTeams");
  const { preferences, updatePreferences } = useFormPreferences();
  const query = useFetchQuery<AgentTeamSummary[], Error>({
    queryKey: ["host", normalizedServerId, "agent-teams"],
    queryFn: async () => {
      if (!client) return EMPTY_TEAMS;
      return (await client.listAgentTeams()).teams;
    },
    enabled: supported && client !== null,
    retry: false,
    dataShape: "value",
    staleTimeMs: 60_000,
  });
  const teams = supported ? (query.data ?? EMPTY_TEAMS) : EMPTY_TEAMS;
  const teamNames = useMemo(() => teams.map((team) => team.name), [teams]);
  const selectedTeam = resolveSelectedTeam({ preferences, serverId, teamNames });
  const selectedRoles = useMemo(
    () => teams.find((team) => team.name === selectedTeam)?.roles ?? [],
    [selectedTeam, teams],
  );
  const onSelectTeam = useCallback(
    (team: string | null) => {
      if (!serverId) return;
      void updatePreferences((current) =>
        rememberSelectedTeam({ preferences: current, serverId, team }),
      ).catch((error) => {
        console.warn("[AgentTeamSelection] persist team preference failed", error);
      });
    },
    [serverId, updatePreferences],
  );

  // Overrides belong to one host and team; switching either starts from the team's models.
  const overrideKey = `${normalizedServerId}\u0000${selectedTeam ?? ""}`;
  const [overrideState, setOverrideState] = useState<{
    key: string;
    models: Record<string, string>;
  }>({ key: overrideKey, models: EMPTY_RECORD });
  const roleModelOverrides =
    overrideState.key === overrideKey ? overrideState.models : EMPTY_RECORD;
  const onSetRoleModel = useCallback(
    (role: string, model: string | null) => {
      const configuredModel = selectedRoles.find((entry) => entry.name === role)?.model;
      setOverrideState((current) => ({
        key: overrideKey,
        models: setRoleModelOverride({
          overrides: current.key === overrideKey ? current.models : EMPTY_RECORD,
          role,
          model,
          configuredModel,
        }),
      }));
    },
    [overrideKey, selectedRoles],
  );

  const snapshot = useProvidersSnapshot(serverId, {
    enabled: supported && selectedRoles.length > 0,
  });
  const roleModelOptions = useMemo(() => {
    const options: Record<string, AgentTeamModelOption[]> = {};
    for (const role of selectedRoles) {
      const entry = snapshot.entries?.find((candidate) => candidate.provider === role.provider);
      options[role.name] = (filterSelectableModels(entry?.models ?? null) ?? []).map((model) => ({
        id: model.id,
        label: model.label,
      }));
    }
    return options;
  }, [selectedRoles, snapshot.entries]);

  return useMemo(
    () => ({
      teams,
      selectedTeam,
      onSelectTeam,
      roleModelOverrides,
      roleModelOptions,
      onSetRoleModel,
    }),
    [teams, selectedTeam, onSelectTeam, roleModelOverrides, roleModelOptions, onSetRoleModel],
  );
}
