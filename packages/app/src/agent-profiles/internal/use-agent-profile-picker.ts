import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { mergeCreateAgentSelectionPreferences } from "@/create-agent-preferences/preferences";
import { useFormPreferences } from "@/hooks/use-form-preferences";
import { useProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { useSessionStore } from "@/stores/session-store";
import { useToast } from "@/contexts/toast-context";
import { toErrorMessage } from "@/utils/error-messages";
import { showProviderNoticeToast } from "@/utils/provider-notice-toast";
import {
  materializeAgentProfile,
  reconcileMaterializedProfileMode,
  toAgentConfigApply,
  type MaterializedAgentProfile,
} from "./materialize-profile";
import { buildAgentProfileTags } from "./profile-summary";
import { useAgentProfiles } from "./use-agent-profiles";

/** The draft composer owns profile application as one state transition. */
export interface DraftAgentProfileControls {
  applyProfile: (profile: MaterializedAgentProfile) => void;
}

export type AgentProfileApplyTarget =
  | { kind: "agent"; agentId: string; availableModeIds: readonly string[] | null }
  | { kind: "draft"; controls: DraftAgentProfileControls };

/** Everything the model picker renders for one profile. It never sees the profile itself. */
export interface AgentProfilePickerRow {
  id: string;
  provider: string;
  /** Icon registry key and identity colour; either may be empty for the default glyph. */
  icon: string;
  color: string;
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
 * pressing one does. A supported host returns an empty row list when there is
 * nothing applicable so the picker can retain its settings shortcut without
 * pinning an empty section. Unsupported or still-loading hosts return `null`.
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
        provider: profile.provider,
        icon: profile.icon ?? "",
        color: profile.color ?? "",
        name: profile.name,
        summary: buildAgentProfileTags({ profile, entries, formatFeatureCount })
          .map((tag) => tag.label)
          .join(" · "),
      })),
    [applicableProfiles, entries, formatFeatureCount],
  );

  const persistSelection = useCallback(
    (resolved: MaterializedAgentProfile) => {
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

      if (target.kind === "draft") {
        target.controls.applyProfile(resolved);
        return;
      }

      const reconciled = reconcileMaterializedProfileMode(resolved, target.availableModeIds);
      if (!reconciled) {
        return;
      }
      persistSelection(reconciled);
      if (!client) {
        return;
      }
      void client
        .applyAgentConfig(target.agentId, toAgentConfigApply(reconciled))
        .then((notice) => showProviderNoticeToast(toast, notice))
        .catch((error) => {
          console.warn("[useAgentProfilePicker] applyAgentConfig failed", error);
          toast.error(toErrorMessage(error));
        });
    },
    [applicableProfiles, client, persistSelection, target, toast],
  );

  return useMemo(
    () => (isSupported && profiles !== null ? { rows, applyProfile } : null),
    [applyProfile, isSupported, profiles, rows],
  );
}
