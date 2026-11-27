import { useEffect, useState, useSyncExternalStore } from "react";
import { useAgentProfiles } from "@/agent-profiles";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import {
  openTeamForm,
  type TeamFormModel,
  type TeamFormSnapshot,
  type TeamFormState,
} from "./team-form-model";

/** One model per mount; the modal keys its body on mode + team name. */
export function useTeamFormModel(snapshot: TeamFormSnapshot): TeamFormModel {
  const [model] = useState(() => openTeamForm(snapshot));
  useEffect(() => () => model.close(), [model]);
  return model;
}

export function useTeamFormState(model: TeamFormModel): TeamFormState {
  return useSyncExternalStore(model.subscribe, model.getState, model.getState);
}

/**
 * Pipes the host's provider catalog and agent profiles into the model. Teams are
 * host-wide, so the catalog is the home-scope one (`cwd: null`), as for profiles.
 */
export function useTeamFormInputs(input: { serverId: string; model: TeamFormModel }): void {
  const { entries } = useProvidersSnapshot(input.serverId, { cwd: null });
  const { profiles } = useAgentProfiles(input.serverId);
  const { model } = input;

  useEffect(() => {
    if (entries) model.applyProviderCatalog(entries);
  }, [entries, model]);

  useEffect(() => {
    if (profiles) model.applyProfiles(profiles);
  }, [profiles, model]);
}
