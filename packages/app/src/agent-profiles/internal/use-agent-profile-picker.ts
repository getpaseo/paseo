import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { AgentProvider } from "@getpaseo/protocol/agent-types";
import type { AgentProfile } from "@getpaseo/protocol/messages";
import { mergeCreateAgentSelectionPreferences } from "@/create-agent-preferences/preferences";
import { useFormPreferences } from "@/hooks/use-form-preferences";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useSessionStore } from "@/stores/session-store";
import { useToast } from "@/contexts/toast-context";
import { toErrorMessage } from "@/utils/error-messages";
import { showProviderNoticeToast } from "@/utils/provider-notice-toast";
import { materializeAgentProfile, toAgentConfigApply } from "./materialize-profile";
import { buildAgentProfileTags } from "./profile-summary";
import { useAgentProfiles } from "./use-agent-profiles";

/** The draft composer's own setters. Applying a profile drives them like a user would. */
export interface DraftAgentProfileControls {
  selectProvider: (provider: AgentProvider) => void;
  selectProviderAndModel: (provider: AgentProvider, modelId: string) => void;
  selectMode: (modeId: string) => void;
  selectThinkingOption: (thinkingOptionId: string) => void;
  setFeature?: (featureId: string, value: unknown) => void;
}

export type AgentProfileApplyTarget =
  | { kind: "agent"; agentId: string }
  | { kind: "draft"; controls: DraftAgentProfileControls };

/** Everything the model picker renders for one profile. It never sees the profile itself. */
export interface AgentProfilePickerRow {
  id: string;
  /** Empty when the profile has no icon; the picker draws its own fallback. */
  icon: string;
  name: string;
  /** "Claude Code · Opus 5 · Plan · Think hard" */
  summary: string;
}

export interface AgentProfilePicker {
  rows: AgentProfilePickerRow[];
  applyProfile: (profileId: string) => void;
}

export interface UseAgentProfilePickerInput {
  serverId: string | null;
  /**
   * Providers this composer can actually run; pass a stable reference. A profile
   * naming anything else is hidden rather than shown as a row that cannot do
   * what it says — a live agent is one provider's process and cannot switch, and
   * the draft form ignores a provider the host does not offer.
   */
  availableProviders: readonly string[];
  target: AgentProfileApplyTarget;
}

/**
 * The agent-profiles section of the model picker: the rows to draw, and what
 * pressing one does. Returns `null` when there is nothing to pin — an old
 * daemon, a host with no profiles, or none this composer could apply.
 */
export function useAgentProfilePicker(
  input: UseAgentProfilePickerInput,
): AgentProfilePicker | null {
  const { serverId, availableProviders, target } = input;
  const { t } = useTranslation();
  const { profiles, isSupported } = useAgentProfiles(serverId);
  // Profiles are host config, so their labels read from the host-wide catalog
  // rather than a workspace's. That is also the key the settings section uses,
  // so every composer on a host shares one query instead of adding its own.
  const { entries } = useProvidersSnapshot(serverId, { cwd: null });
  const { updatePreferences } = useFormPreferences();
  const client = useSessionStore((state) => state.sessions[serverId ?? ""]?.client ?? null);
  const toast = useToast();

  const applicableProfiles = useMemo(() => {
    if (!isSupported || !profiles) {
      return [];
    }
    const available = new Set(availableProviders);
    return profiles.filter((profile) => available.has(profile.provider));
  }, [availableProviders, isSupported, profiles]);

  const formatFeatureCount = useCallback(
    (count: number) =>
      count === 1
        ? t("settings.host.agentProfiles.featureCountOne", { count })
        : t("settings.host.agentProfiles.featureCount", { count }),
    [t],
  );

  const rows = useMemo<AgentProfilePickerRow[]>(
    () =>
      applicableProfiles.map((profile) => ({
        id: profile.id,
        icon: profile.icon ?? "",
        name: profile.name,
        summary: buildAgentProfileTags({ profile, entries, formatFeatureCount })
          .map((tag) => tag.label)
          .join(" · "),
      })),
    [applicableProfiles, entries, formatFeatureCount],
  );

  const persistSelection = useCallback(
    (profile: AgentProfile) => {
      const resolved = materializeAgentProfile(profile);
      void updatePreferences((current) =>
        mergeCreateAgentSelectionPreferences({
          preferences: current,
          provider: resolved.provider,
          modelId: resolved.modelId,
          modeId: resolved.modeId,
          thinkingOptionId: resolved.thinkingOptionId,
          ...(Object.keys(resolved.featureValues).length > 0
            ? { featureValues: resolved.featureValues }
            : {}),
        }),
      ).catch((error) => {
        console.warn("[useAgentProfilePicker] persist profile selection failed", error);
      });
    },
    [updatePreferences],
  );

  const applyProfile = useCallback(
    (profileId: string) => {
      const profile = applicableProfiles.find((entry) => entry.id === profileId);
      if (!profile) {
        return;
      }
      const resolved = materializeAgentProfile(profile);

      // Persist on both paths, before driving the controls. The draft form drops
      // its local feature values when the provider changes, so preferences are
      // the only channel that survives a profile that switches provider.
      persistSelection(profile);

      if (target.kind === "draft") {
        const { controls } = target;
        if (resolved.modelId) {
          controls.selectProviderAndModel(resolved.provider, resolved.modelId);
        } else {
          controls.selectProvider(resolved.provider);
        }
        if (resolved.modeId) {
          controls.selectMode(resolved.modeId);
        }
        if (resolved.thinkingOptionId) {
          controls.selectThinkingOption(resolved.thinkingOptionId);
        }
        for (const [featureId, value] of Object.entries(resolved.featureValues)) {
          controls.setFeature?.(featureId, value);
        }
        return;
      }

      if (!client) {
        return;
      }
      void client
        .applyAgentConfig(target.agentId, toAgentConfigApply(resolved))
        .then((notice) => showProviderNoticeToast(toast, notice))
        .catch((error) => {
          console.warn("[useAgentProfilePicker] applyAgentConfig failed", error);
          toast.error(toErrorMessage(error));
        });
    },
    [applicableProfiles, client, persistSelection, target, toast],
  );

  return useMemo(() => (rows.length > 0 ? { rows, applyProfile } : null), [applyProfile, rows]);
}
