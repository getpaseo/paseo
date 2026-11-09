import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { AgentProvider, ProviderOptions } from "@getpaseo/protocol/agent-types";
import {
  draftControlsRequest,
  openDraftOptions,
  ownDraftOptions,
  shownDraftOptions,
  viewDraftOptions,
} from "@/agent-controls/draft-options-model";
import type { ComposerOptionControls } from "@/agent-controls/option-controls";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { mergeProviderPreferences, useFormPreferences } from "./use-form-preferences";

/**
 * Adapter between a draft's options model and the screen: it sends the model's complete options
 * to the daemon, hands the answer back, and persists the user's toggles as last-used values.
 */
export function useDraftProviderOptions(input: {
  serverId: string | null | undefined;
  provider: AgentProvider | null;
  /** The form's provider as it is now, which a render may not have reached yet. */
  getProvider: () => AgentProvider | null;
  cwd: string | null | undefined;
  modeId: string | null | undefined;
  modelId: string | null | undefined;
  thinkingOptionId: string | null | undefined;
  initialOptions?: ProviderOptions;
}) {
  const { t } = useTranslation();
  const {
    serverId,
    provider,
    getProvider,
    cwd,
    modeId,
    modelId,
    thinkingOptionId,
    initialOptions,
  } = input;
  const [model] = useState(() =>
    openDraftOptions({ provider, seed: initialOptions, currentProvider: getProvider }),
  );
  const state = useSyncExternalStore(model.subscribe, model.getState, model.getState);
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const { preferences, updatePreferences } = useFormPreferences();
  const normalizedCwd = cwd?.trim() || "";
  const persisted = preferences.providerPreferences?.[provider ?? ""]?.options;

  useEffect(() => model.observeProvider(provider), [model, provider]);
  useEffect(() => model.setRemembered(persisted ?? {}), [model, persisted]);

  const ownOptions = ownDraftOptions(state);
  const draftConfig = useMemo(
    () =>
      draftControlsRequest(state, {
        provider,
        cwd: normalizedCwd,
        modeId,
        modelId,
        thinkingOptionId,
      }),
    [modeId, modelId, normalizedCwd, provider, state, thinkingOptionId],
  );
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

  // An edit belongs to the provider the form has now, even before the render that shows it.
  const setOption = useCallback(
    (key: string, value: unknown) => {
      model.setOption(key, value);
      const current = getProvider();
      if (!current) return;
      void updatePreferences((stored) =>
        mergeProviderPreferences({
          preferences: stored,
          provider: current,
          updates: { options: { [key]: value } },
        }),
      ).catch((error) => {
        console.warn("[useDraftProviderOptions] persist option preference failed", error);
      });
    },
    [getProvider, model, updatePreferences],
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

  // What the draft will create with, the plugin's own edits included, before the daemon answers.
  const shownOptions = shownDraftOptions(state, { provider, requestKey });

  return {
    optionControls,
    options: ownOptions,
    shownOptions,
    setOption,
    applyProfile: model.applyProfile,
  };
}
