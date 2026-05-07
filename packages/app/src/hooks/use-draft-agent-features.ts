import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { AgentProvider, AgentSessionConfig } from "@server/server/agent/agent-sdk-types";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import {
  mergeProviderPreferences,
  mergeWorkspaceAgentDefaults,
  useFormPreferences,
} from "./use-form-preferences";
import {
  applyFeatureValues,
  pruneFeatureValues,
  resolveFeatureValues,
} from "./feature-preferences";

type DraftFeatureConfig = Pick<
  AgentSessionConfig,
  "provider" | "cwd" | "modeId" | "model" | "thinkingOptionId"
>;

export function useDraftAgentFeatures(input: {
  serverId: string | null | undefined;
  provider: AgentProvider | null;
  cwd: string | null | undefined;
  modeId: string | null | undefined;
  modelId: string | null | undefined;
  thinkingOptionId: string | null | undefined;
  workspaceDefaultsKey?: string | null;
}) {
  const { serverId, provider, cwd, modeId, modelId, thinkingOptionId, workspaceDefaultsKey } =
    input;
  const [localFeatureValues, setLocalFeatureValues] = useState<Record<string, unknown>>({});
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const { preferences, updatePreferences } = useFormPreferences();
  const normalizedCwd = cwd?.trim() || "";
  const normalizedProvider = provider ?? null;
  const workspaceDefaults = workspaceDefaultsKey
    ? preferences.workspaceAgentDefaults?.[workspaceDefaultsKey]
    : undefined;
  const persistedFeatureValues = useMemo(() => {
    if (!provider) {
      return {};
    }
    if (workspaceDefaults?.provider === provider) {
      return workspaceDefaults.featureValues ?? {};
    }
    return preferences.providerPreferences?.[provider]?.featureValues ?? {};
  }, [
    preferences.providerPreferences,
    provider,
    workspaceDefaults?.featureValues,
    workspaceDefaults?.provider,
  ]);

  const draftConfig = useMemo<DraftFeatureConfig | null>(() => {
    if (!normalizedProvider || !normalizedCwd) {
      return null;
    }

    return {
      provider: normalizedProvider,
      cwd: normalizedCwd,
      ...(modeId ? { modeId } : {}),
      ...(modelId ? { model: modelId } : {}),
      ...(thinkingOptionId ? { thinkingOptionId } : {}),
    };
  }, [modeId, modelId, normalizedCwd, normalizedProvider, thinkingOptionId]);

  const featuresQuery = useQuery({
    queryKey: [
      "providerFeatures",
      serverId ?? null,
      normalizedProvider,
      normalizedCwd || null,
      modeId ?? null,
      modelId ?? null,
      thinkingOptionId ?? null,
    ],
    enabled: Boolean(serverId && client && isConnected && draftConfig),
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      if (!client || !draftConfig) {
        throw new Error("Host is not connected");
      }
      const payload = await client.listProviderFeatures(draftConfig);
      if (payload.error) {
        throw new Error(payload.error);
      }
      return payload.features ?? [];
    },
  });
  const availableFeaturesRaw = featuresQuery.data;
  const availableFeatures = useMemo(() => availableFeaturesRaw ?? [], [availableFeaturesRaw]);
  const featureValues = useMemo(
    () =>
      resolveFeatureValues({
        features: availableFeatures,
        persistedFeatureValues,
        localFeatureValues,
      }),
    [availableFeatures, localFeatureValues, persistedFeatureValues],
  );

  const features = useMemo(() => {
    return applyFeatureValues(availableFeatures, featureValues);
  }, [availableFeatures, featureValues]);

  useEffect(() => {
    setLocalFeatureValues({});
  }, [provider]);

  useEffect(() => {
    const next = pruneFeatureValues(localFeatureValues, availableFeatures);
    if (next !== localFeatureValues) {
      setLocalFeatureValues(next);
    }
  }, [availableFeatures, localFeatureValues]);

  const effectiveFeatureValues = Object.keys(featureValues).length > 0 ? featureValues : undefined;
  const setFeatureValue = useCallback(
    (featureId: string, value: unknown) => {
      setLocalFeatureValues((current) => {
        if (Object.is(current[featureId], value)) {
          return current;
        }

        return { ...current, [featureId]: value };
      });
      if (!provider) {
        return;
      }
      void updatePreferences((current) =>
        workspaceDefaultsKey
          ? mergeWorkspaceAgentDefaults({
              preferences: current,
              workspaceKey: workspaceDefaultsKey,
              updates: {
                provider,
                model: modelId || undefined,
                modeId: modeId || undefined,
                thinkingOptionId: thinkingOptionId || undefined,
                featureValues: {
                  [featureId]: value,
                },
              },
            })
          : mergeProviderPreferences({
              preferences: current,
              provider,
              updates: {
                featureValues: {
                  [featureId]: value,
                },
              },
            }),
      ).catch((error) => {
        console.warn("[useDraftAgentFeatures] persist feature preference failed", error);
      });
    },
    [modeId, modelId, provider, thinkingOptionId, updatePreferences, workspaceDefaultsKey],
  );

  return {
    features,
    featureValues: effectiveFeatureValues,
    isLoading: featuresQuery.isLoading,
    setFeatureValue,
  };
}
