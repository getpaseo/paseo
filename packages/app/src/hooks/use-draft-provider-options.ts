import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type {
  AgentProvider,
  AgentSessionConfig,
  ProviderOptions,
} from "@getpaseo/protocol/agent-types";
import {
  openDraftOptions,
  ownDraftOptions,
  viewDraftOptions,
} from "@/agent-controls/draft-options-model";
import type { ComposerOptionControls } from "@/agent-controls/option-controls";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { mergeProviderPreferences, useFormPreferences } from "./use-form-preferences";

type DraftControlsConfig = Pick<
  AgentSessionConfig,
  "provider" | "cwd" | "modeId" | "model" | "thinkingOptionId" | "providerOptions"
>;

/**
 * Adapter between a draft's options model and the screen: it sends the model's complete options
 * to the daemon, hands the answer back, and persists the user's toggles as last-used values.
 */
export function useDraftProviderOptions(input: {
  serverId: string | null | undefined;
  provider: AgentProvider | null;
  cwd: string | null | undefined;
  modeId: string | null | undefined;
  modelId: string | null | undefined;
  thinkingOptionId: string | null | undefined;
  initialOptions?: ProviderOptions;
}) {
  const { t } = useTranslation();
  const { serverId, provider, cwd, modeId, modelId, thinkingOptionId, initialOptions } = input;
  const [model] = useState(() => openDraftOptions({ provider, seed: initialOptions }));
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const { preferences, updatePreferences } = useFormPreferences();
  const normalizedCwd = cwd?.trim() || "";
  const persisted = preferences.providerPreferences?.[provider ?? ""]?.options;

  useEffect(() => model.observeProvider(provider), [model, provider]);
  useEffect(() => model.setRemembered(persisted ?? {}), [model, persisted]);

  const ownOptions = ownDraftOptions(state);
  const draftConfig = useMemo<DraftControlsConfig | null>(() => {
    if (!provider || !normalizedCwd) return null;
    return {
      provider,
      cwd: normalizedCwd,
      ...(modeId ? { modeId } : {}),
      ...(modelId ? { model: modelId } : {}),
      ...(thinkingOptionId ? { thinkingOptionId } : {}),
      ...(ownOptions ? { providerOptions: ownOptions } : {}),
    };
  }, [modeId, modelId, normalizedCwd, ownOptions, provider, thinkingOptionId]);
  const queryKey = useMemo(
    () => ["providerControls", serverId ?? null, draftConfig],
    [draftConfig, serverId],
  );
  const requestKey = JSON.stringify(queryKey);

  const { data } = useFetchQuery({
    queryKey,
    dataShape: "value",
    staleTimeMs: 5 * 60 * 1000,
    enabled: Boolean(serverId && client && isConnected && draftConfig),
    queryFn: async () => {
      if (!client || !draftConfig) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const payload = await client.listProviderControls(draftConfig);
      if (payload.error) {
        throw new Error(payload.error);
      }
      return { controls: payload.controls ?? [], options: payload.options ?? {} };
    },
  });

  useEffect(() => {
    if (provider && data) model.applyResolved({ provider, requestKey, ...data });
  }, [data, model, provider, requestKey]);

  const setOption = useCallback(
    (key: string, value: unknown) => {
      model.setOption(key, value);
      if (!provider) return;
      void updatePreferences((current) =>
        mergeProviderPreferences({
          preferences: current,
          provider,
          updates: { options: { [key]: value } },
        }),
      ).catch((error) => {
        console.warn("[useDraftProviderOptions] persist option preference failed", error);
      });
    },
    [model, provider, updatePreferences],
  );

  const view = viewDraftOptions(state, { provider, requestKey });
  const viewControls = view?.controls;
  const viewOptions = view?.options;
  const optionControls = useMemo<ComposerOptionControls | undefined>(
    () =>
      viewControls && viewOptions
        ? { controls: viewControls, options: viewOptions, onSetOption: setOption }
        : undefined,
    [setOption, viewControls, viewOptions],
  );

  return { optionControls, options: ownOptions, applyProfile: model.applyProfile };
}
