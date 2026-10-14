import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type {
  AgentComposerControl,
  AgentProvider,
  AgentSessionConfig,
} from "@getpaseo/protocol/agent-types";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useHostFeature } from "@/runtime/host-features";
import { mergeProviderPreferences, useFormPreferences } from "./use-form-preferences";
import {
  applyControlValues,
  applyFeatureValues,
  pruneControlValues,
  pruneFeatureValues,
  resolveControlValues,
  resolveFeatureValues,
} from "./feature-preferences";

type DraftFeatureConfig = Pick<
  AgentSessionConfig,
  "provider" | "cwd" | "modeId" | "model" | "thinkingOptionId" | "controlValues"
> & { surface: "draft" };

export function useDraftAgentFeatures(input: {
  serverId: string | null | undefined;
  provider: AgentProvider | null;
  cwd: string | null | undefined;
  modeId: string | null | undefined;
  modelId: string | null | undefined;
  thinkingOptionId: string | null | undefined;
  initialFeatureValues?: Record<string, unknown>;
  initialControlValues?: Record<string, unknown>;
}) {
  const { t } = useTranslation();
  const {
    serverId,
    provider,
    cwd,
    modeId,
    modelId,
    thinkingOptionId,
    initialFeatureValues,
    initialControlValues,
  } = input;
  const [localFeatureValues, setLocalFeatureValues] = useState<Record<string, unknown>>(
    () => initialFeatureValues ?? {},
  );
  const [localControlValues, setLocalControlValues] = useState<Record<string, unknown>>(
    () => initialControlValues ?? {},
  );
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const controlsSupported = useHostFeature(serverId, "providerComposerControls");
  const { preferences, updatePreferences } = useFormPreferences();
  const normalizedCwd = cwd?.trim() || "";
  const normalizedProvider = provider ?? null;
  const previousProviderRef = useRef<AgentProvider | null>(normalizedProvider);
  const persistedFeatureValues = useMemo(
    () => (provider ? (preferences.providerPreferences?.[provider]?.featureValues ?? {}) : {}),
    [preferences.providerPreferences, provider],
  );
  const persistedControlValues = useMemo(
    () => (provider ? (preferences.providerPreferences?.[provider]?.controlValues ?? {}) : {}),
    [preferences.providerPreferences, provider],
  );

  const draftConfig = useMemo<DraftFeatureConfig | null>(() => {
    if (!normalizedProvider || !normalizedCwd) {
      return null;
    }
    const controlValues = { ...persistedControlValues, ...localControlValues };

    return {
      provider: normalizedProvider,
      cwd: normalizedCwd,
      ...(modeId ? { modeId } : {}),
      ...(modelId ? { model: modelId } : {}),
      ...(thinkingOptionId ? { thinkingOptionId } : {}),
      ...(Object.keys(controlValues).length > 0 ? { controlValues } : {}),
      surface: "draft",
    };
  }, [
    localControlValues,
    modeId,
    modelId,
    normalizedCwd,
    normalizedProvider,
    persistedControlValues,
    thinkingOptionId,
  ]);

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
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const payload = await client.listProviderFeatures(draftConfig);
      if (payload.error) {
        throw new Error(payload.error);
      }
      return {
        features: payload.features ?? [],
        composerControls: payload.composerControls ?? [],
      };
    },
  });
  const availableFeaturesRaw = featuresQuery.data?.features;
  const availableFeatures = useMemo(() => availableFeaturesRaw ?? [], [availableFeaturesRaw]);
  const availableControlsRaw = featuresQuery.data?.composerControls;
  const availableControls = useMemo<AgentComposerControl[]>(
    () => (controlsSupported ? (availableControlsRaw ?? []) : []),
    [availableControlsRaw, controlsSupported],
  );
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
  const controlValues = useMemo(
    () =>
      resolveControlValues({
        controls: availableControls,
        persistedControlValues,
        localControlValues,
      }),
    [availableControls, localControlValues, persistedControlValues],
  );
  const resolvedControls = useMemo(() => {
    return applyControlValues(availableControls, controlValues);
  }, [availableControls, controlValues]);

  useEffect(() => {
    const previousProvider = previousProviderRef.current;
    previousProviderRef.current = normalizedProvider;
    if (previousProvider === null) {
      return;
    }
    if (previousProvider !== normalizedProvider) {
      setLocalFeatureValues({});
      setLocalControlValues({});
    }
  }, [normalizedProvider]);

  useEffect(() => {
    if (availableFeaturesRaw === undefined) {
      return;
    }
    const next = pruneFeatureValues(localFeatureValues, availableFeatures);
    if (next !== localFeatureValues) {
      setLocalFeatureValues(next);
    }
    const nextControls = pruneControlValues(localControlValues, availableControls);
    if (nextControls !== localControlValues) {
      setLocalControlValues(nextControls);
    }
  }, [
    availableControls,
    availableFeatures,
    availableFeaturesRaw,
    localControlValues,
    localFeatureValues,
  ]);

  const effectiveFeatureValues = Object.keys(featureValues).length > 0 ? featureValues : undefined;
  const effectiveControlValues = Object.keys(controlValues).length > 0 ? controlValues : undefined;
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
        mergeProviderPreferences({
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
    [provider, updatePreferences],
  );

  const applyProfileFeatureValues = useCallback((values: Record<string, unknown>) => {
    setLocalFeatureValues(values);
  }, []);

  const setControlValue = useCallback(
    (controlId: string, value: unknown) => {
      setLocalControlValues((current) => {
        if (Object.is(current[controlId], value)) {
          return current;
        }

        return { ...current, [controlId]: value };
      });
      if (!provider) {
        return;
      }
      void updatePreferences((current) =>
        mergeProviderPreferences({
          preferences: current,
          provider,
          updates: {
            controlValues: {
              [controlId]: value,
            },
          },
        }),
      ).catch((error) => {
        console.warn("[useDraftAgentFeatures] persist control preference failed", error);
      });
    },
    [provider, updatePreferences],
  );

  const applyProfileControlValues = useCallback((values: Record<string, unknown>) => {
    setLocalControlValues(values);
  }, []);

  return {
    features,
    featureValues: effectiveFeatureValues,
    controls: resolvedControls,
    controlValues: effectiveControlValues,
    isLoading: featuresQuery.isLoading,
    setFeatureValue,
    setControlValue,
    applyProfileFeatureValues,
    applyProfileControlValues,
  };
}
