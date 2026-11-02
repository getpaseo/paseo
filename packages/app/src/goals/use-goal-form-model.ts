import { useEffect, useMemo, useState } from "react";
import { useCheckoutStatusQuery } from "@/git/use-status-query";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { filterSelectableModels } from "@/provider-selection/model-catalog";
import { buildSelectableProviderSelectorProviders } from "@/provider-selection/provider-selection";
import { useHostFeatureMap } from "@/runtime/host-features";
import { useHostRuntimeConnectionStatuses, useHosts } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import {
  openGoalForm,
  type GoalFormHost,
  type GoalFormModel,
  type GoalFormSnapshot,
} from "./goal-form-model";
import {
  buildGoalProjectOptions,
  goalCwdCheckFromStatus,
  type GoalProjectOption,
} from "./goal-projects";

/** One model per mount (docs/forms.md): later prop changes never rebuild it. */
export function useGoalFormModel(snapshot: GoalFormSnapshot): GoalFormModel {
  const [model] = useState(() => openGoalForm(snapshot));

  useEffect(() => {
    return () => {
      model.close();
    };
  }, [model]);

  return model;
}

/** Pipes the host's registered providers and their models into the model once the goal runs with agents. */
export function useGoalFormProviderOptions(input: {
  model: GoalFormModel;
  serverId: string;
  enabled: boolean;
}) {
  const { model, serverId, enabled } = input;
  const snapshot = useProvidersSnapshot(serverId, { enabled });

  useEffect(() => {
    if (!enabled || !snapshot.entries) {
      return;
    }
    const entries = snapshot.entries;
    model.applyProviderOptions(
      buildSelectableProviderSelectorProviders(entries).map(({ id, label }) => ({
        id,
        label,
        models: (
          filterSelectableModels(entries.find((entry) => entry.provider === id)?.models ?? null) ??
          []
        ).map((definition) => ({
          id: definition.id,
          label: definition.label,
          description: definition.description,
          isDefault: definition.isDefault,
          thinkingOptions: definition.thinkingOptions,
        })),
      })),
    );
  }, [enabled, model, snapshot.entries]);

  return snapshot;
}

/** The host's git projects, most recently used first, from the projects and workspaces it sent. */
export function useGoalProjectOptions(serverId: string | null): GoalProjectOption[] {
  const projects = useSessionStore((state) =>
    serverId ? state.sessions[serverId]?.projects : undefined,
  );
  const workspaces = useSessionStore((state) =>
    serverId ? state.sessions[serverId]?.workspaces : undefined,
  );
  return useMemo(
    () =>
      buildGoalProjectOptions({
        projects: projects?.values() ?? [],
        workspaces: workspaces?.values() ?? [],
      }),
    [projects, workspaces],
  );
}

/** Pipes the chosen host's projects into the model. */
export function useGoalFormProjectOptions(input: { model: GoalFormModel; serverId: string }) {
  const { model, serverId } = input;
  const options = useGoalProjectOptions(serverId);
  const hasHydrated = useSessionStore(
    (state) => state.sessions[serverId]?.hasHydratedWorkspaces === true,
  );

  useEffect(() => {
    // Before the host sent its workspaces an empty list means "not yet", not "no projects".
    if (!hasHydrated && options.length === 0) {
      return;
    }
    model.applyProjectOptions(options);
  }, [hasHydrated, model, options]);
}

/** Asks the host whether the chosen directory is a git repository, and on which branch. */
export function useGoalFormCwdCheck(input: {
  model: GoalFormModel;
  serverId: string;
  cwd: string;
  enabled: boolean;
}): void {
  const { model, serverId, enabled } = input;
  // A typed path settles before it is checked.
  const cwd = useDebouncedValue(input.cwd.trim(), 400);
  const query = useCheckoutStatusQuery({ serverId, cwd: enabled ? cwd : "" });

  useEffect(() => {
    if (!enabled || !cwd) {
      return;
    }
    model.applyCwdCheck(goalCwdCheckFromStatus(cwd, query.status));
  }, [cwd, enabled, model, query.status]);
}

/** Pipes the online hosts that run goals into the model. */
export function useGoalFormHosts(model: GoalFormModel): void {
  const profiles = useHosts();
  const serverIds = useMemo(() => profiles.map((host) => host.serverId), [profiles]);
  const goals = useHostFeatureMap(serverIds, "goals");
  const budgets = useHostFeatureMap(serverIds, "goalBudgets");
  const thinking = useHostFeatureMap(serverIds, "goalThinking");
  const configEdit = useHostFeatureMap(serverIds, "goalConfigEdit");
  // COMPAT(goalUserWait): added in v0.13.14, remove gate after 2027-10-28.
  const userWait = useHostFeatureMap(serverIds, "goalUserWait");
  const statuses = useHostRuntimeConnectionStatuses(serverIds);
  const hosts = useMemo<GoalFormHost[]>(
    () =>
      profiles
        .filter(
          (host) => goals.get(host.serverId) === true && statuses.get(host.serverId) === "online",
        )
        .map((host) => ({
          serverId: host.serverId,
          label: host.label,
          budgetSupported: budgets.get(host.serverId) === true,
          thinkingSupported: thinking.get(host.serverId) === true,
          userWaitSupported: userWait.get(host.serverId) === true,
          autoPermissionSupported: configEdit.get(host.serverId) === true,
        })),
    [budgets, configEdit, goals, profiles, statuses, thinking, userWait],
  );

  useEffect(() => {
    model.applyHosts(hosts);
  }, [hosts, model]);
}
