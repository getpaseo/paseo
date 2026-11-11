import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useFetchQuery } from "@/data/query";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type { AgentProfileFormModel, AgentProfileFormState } from "./profile-form-model";

/**
 * Agent profiles are host-wide, so the catalog is probed in the daemon's home
 * directory (`cwd: null` for the snapshot, `~` for the feature listing) rather
 * than in a workspace. A profile that resolved against one project's directory
 * would name models the next project cannot launch.
 */
const HOME_SCOPE_CWD = "~";

export function useAgentProfileFormCatalog(input: {
  serverId: string;
  model: AgentProfileFormModel;
}): void {
  const { entries } = useProvidersSnapshot(input.serverId, { cwd: null });

  useEffect(() => {
    if (!entries) {
      return;
    }
    input.model.applyProviderCatalog(entries);
  }, [entries, input.model]);
}

export function useAgentProfileFormFeatures(input: {
  serverId: string;
  model: AgentProfileFormModel;
  state: AgentProfileFormState;
}): void {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(input.serverId);
  const isConnected = useHostRuntimeIsConnected(input.serverId);
  const request = input.state.featureRequest;
  const requestKey = input.state.featureRequestKey;

  // `dataShape: "value"` and not `"list"`: a list shape keeps the previous
  // page's data while the next request is in flight, which would hand the
  // features of one provider/model combination to the key of another.
  const featuresQuery = useFetchQuery({
    queryKey: ["agentProfileFeatures", input.serverId, requestKey],
    dataShape: "value",
    staleTimeMs: 5 * 60 * 1000,
    enabled: Boolean(client && isConnected && request),
    retry: false,
    queryFn: async () => {
      if (!client || !request) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const payload = await client.listProviderFeatures({ ...request, cwd: HOME_SCOPE_CWD });
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload.features ?? [];
    },
  });

  const { data, isError } = featuresQuery;
  const { model } = input;

  useEffect(() => {
    if (!requestKey || !data) {
      return;
    }
    model.applyFeatures(requestKey, data);
  }, [data, model, requestKey]);

  useEffect(() => {
    if (!requestKey || !isError) {
      return;
    }
    model.applyFeaturesUnavailable(requestKey);
  }, [isError, model, requestKey]);
}
