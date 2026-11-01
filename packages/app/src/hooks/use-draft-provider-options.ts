import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  AgentProvider,
  AgentSessionConfig,
  ProviderOptions,
} from "@getpaseo/protocol/agent-types";
import type { ComposerOptionControls } from "@/agent-controls/option-controls";
import { useFetchQuery } from "@/data/query";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { composeDraftOptions } from "./draft-provider-options";
import { mergeProviderPreferences, useFormPreferences } from "./use-form-preferences";

type DraftControlsConfig = Pick<
  AgentSessionConfig,
  "provider" | "cwd" | "modeId" | "model" | "thinkingOptionId" | "providerOptions"
>;

/**
 * The options a draft agent would run with, and the controls that draw them. The daemon resolves
 * the values (config defaults, aliases such as a legacy Fast profile's `service_tier`); the draft
 * adds only what the user chose here or last time.
 *
 * - `seed`: options the draft starts from (a profile, a workspace setup). Sent to the daemon.
 * - `edits`: toggles made in this draft.
 * - persisted: last-used control values for the provider.
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
  const [seed, setSeed] = useState<ProviderOptions>(() => initialOptions ?? {});
  const [edits, setEdits] = useState<ProviderOptions>({});
  const client = useHostRuntimeClient(serverId ?? "");
  const isConnected = useHostRuntimeIsConnected(serverId ?? "");
  const { preferences, updatePreferences } = useFormPreferences();
  const normalizedCwd = cwd?.trim() || "";
  const normalizedProvider = provider ?? null;
  const previousProviderRef = useRef<AgentProvider | null>(normalizedProvider);
  const persisted = useMemo(
    () => (provider ? (preferences.providerPreferences?.[provider]?.options ?? {}) : {}),
    [preferences.providerPreferences, provider],
  );

  const draftConfig = useMemo<DraftControlsConfig | null>(() => {
    if (!normalizedProvider || !normalizedCwd) return null;
    return {
      provider: normalizedProvider,
      cwd: normalizedCwd,
      ...(modeId ? { modeId } : {}),
      ...(modelId ? { model: modelId } : {}),
      ...(thinkingOptionId ? { thinkingOptionId } : {}),
      ...(Object.keys(seed).length > 0 ? { providerOptions: seed } : {}),
    };
  }, [modeId, modelId, normalizedCwd, normalizedProvider, seed, thinkingOptionId]);

  const controlsQuery = useFetchQuery({
    queryKey: [
      "providerControls",
      serverId ?? null,
      normalizedProvider,
      normalizedCwd || null,
      modeId ?? null,
      modelId ?? null,
      thinkingOptionId ?? null,
      seed,
    ],
    enabled: Boolean(serverId && client && isConnected && draftConfig),
    dataShape: "value",
    staleTimeMs: 5 * 60 * 1000,
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
  const controls = controlsQuery.data?.controls;
  const resolved = controlsQuery.data?.options;

  const { shown: options, own: ownOptions } = useMemo(
    () => composeDraftOptions({ seed, persisted, edits, controls, resolved }),
    [controls, edits, persisted, resolved, seed],
  );

  useEffect(() => {
    const previousProvider = previousProviderRef.current;
    previousProviderRef.current = normalizedProvider;
    if (previousProvider === null) return;
    if (previousProvider !== normalizedProvider) {
      setSeed({});
      setEdits({});
    }
  }, [normalizedProvider]);

  const setOption = useCallback(
    (key: string, value: unknown) => {
      setEdits((current) =>
        Object.is(current[key], value) ? current : { ...current, [key]: value },
      );
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
    [provider, updatePreferences],
  );

  const applyProfileOptions = useCallback((profileOptions: ProviderOptions) => {
    setSeed(profileOptions);
    setEdits({});
  }, []);

  const optionControls = useMemo<ComposerOptionControls | undefined>(
    () => (controls ? { controls, options, onSetOption: setOption } : undefined),
    [controls, options, setOption],
  );

  return {
    optionControls,
    options: ownOptions,
    isLoading: controlsQuery.isLoading,
    applyProfileOptions,
  };
}
