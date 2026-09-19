import { useCallback, useMemo } from "react";
import { router, type Href } from "expo-router";
import { useTranslation } from "react-i18next";
import { Bot } from "lucide-react-native";
import { AgentProfileGlyph, materializeAgentProfile, useAgentProfiles } from "@/agent-profiles";
import { mergeCreateAgentSelectionPreferences } from "@/create-agent-preferences/preferences";
import { useFormPreferences } from "@/hooks/use-form-preferences";
import { canCreateWorktreeForProjectKind } from "@/projects/host-projects";
import { useHostFeature } from "@/runtime/host-features";
import { useHosts } from "@/runtime/host-runtime";
import {
  useActiveWorkspaceSelection,
  useLastWorkspaceSelection,
} from "@/stores/navigation-active-workspace-store";
import { useWorkspace } from "@/stores/session-store-hooks";
import { clearCommandCenterFocusRestoreElement } from "@/utils/command-center-focus-restore";
import { buildNewWorkspaceRoute, buildSettingsHostSectionRoute } from "@/utils/host-routes";
import type { CommandCenterIcon, CommandCenterIconProps } from "./contributions";
import { useCommandCenterActions } from "./provider";
import {
  buildAgentProfileCommandCenterContributions,
  type AgentProfileCommandCenterHost,
} from "./agent-profile-contributions";
import { getCommandCenterIcon } from "./icon";

const ManageProfilesIcon = getCommandCenterIcon(Bot);

const glyphIconCache = new Map<string, CommandCenterIcon>();

function agentProfileGlyphIcon(icon: string | undefined, color: string | undefined) {
  const key = `${icon ?? ""}|${color ?? ""}`;
  const cached = glyphIconCache.get(key);
  if (cached) {
    return cached;
  }
  function ProfileGlyph({ size }: CommandCenterIconProps) {
    return <AgentProfileGlyph icon={icon} color={color} size={size} />;
  }
  glyphIconCache.set(key, ProfileGlyph);
  return ProfileGlyph;
}

/**
 * Agent profiles in the root command palette, on every platform. A start entry
 * remembers the profile as the New Workspace composer defaults and opens that
 * composer on the resolved host, so the agent it creates carries the profile's
 * provider, model, mode, thinking option and features. The manage entry lands
 * on the host settings section that owns the list — the same route the model
 * picker's edit shortcut uses.
 */
export function useAgentProfileCommandCenterActions(): void {
  const { t } = useTranslation();
  const { updatePreferences } = useFormPreferences();
  const hosts = useHosts();
  const activeSelection = useActiveWorkspaceSelection();
  const lastSelection = useLastWorkspaceSelection();

  const activeServerId = activeSelection?.serverId ?? null;
  const activeWorkspaceId = activeSelection?.workspaceId ?? null;
  const serverId = useMemo(() => {
    const selected = activeServerId ?? lastSelection?.serverId ?? null;
    if (selected && hosts.some((host) => host.serverId === selected)) {
      return selected;
    }
    // A stale last-workspace selection (or several hosts with no selection at
    // all) must not resolve to an unknown id; with one host it is unambiguous.
    if (hosts.length === 1) {
      return hosts[0]?.serverId ?? null;
    }
    return null;
  }, [activeServerId, hosts, lastSelection?.serverId]);

  const { profiles, isSupported } = useAgentProfiles(serverId);

  // Same placement context the global New Workspace action uses, so a profile
  // started mid-workspace opens the composer inside its project.
  const activeWorkspace = useWorkspace(activeServerId, activeWorkspaceId);
  const supportsWorkspaceMultiplicity = useHostFeature(serverId, "workspaceMultiplicity");
  const canUseActiveWorkspaceContext = Boolean(
    activeWorkspace &&
    (supportsWorkspaceMultiplicity || canCreateWorktreeForProjectKind(activeWorkspace.projectKind)),
  );

  const startAgentWithProfile = useCallback(
    (profileId: string) => {
      const profile = profiles?.find((entry) => entry.id === profileId);
      if (!profile || !serverId) {
        return;
      }
      const resolved = materializeAgentProfile(profile);
      clearCommandCenterFocusRestoreElement();
      void (async () => {
        try {
          await updatePreferences((current) =>
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
          );
        } catch (error) {
          console.warn("[CommandCenter] Failed to remember agent profile selection", error);
        }
        router.navigate(
          (serverId
            ? buildNewWorkspaceRoute(
                activeWorkspace && canUseActiveWorkspaceContext
                  ? {
                      serverId,
                      sourceDirectory: activeWorkspace.projectRootPath,
                      projectId: activeWorkspace.projectId,
                    }
                  : { serverId },
              )
            : buildNewWorkspaceRoute()) as Href,
        );
      })();
    },
    [activeWorkspace, canUseActiveWorkspaceContext, profiles, serverId, updatePreferences],
  );

  const openAgentProfiles = useCallback(() => {
    if (!serverId) {
      return;
    }
    clearCommandCenterFocusRestoreElement();
    router.push(buildSettingsHostSectionRoute(serverId, "agents"));
  }, [serverId]);

  const openHostAgentProfiles = useCallback((targetServerId: string) => {
    clearCommandCenterFocusRestoreElement();
    router.push(buildSettingsHostSectionRoute(targetServerId, "agents"));
  }, []);

  const actions = useMemo(
    () =>
      buildAgentProfileCommandCenterContributions({
        serverId,
        hosts: hosts.map(
          (host): AgentProfileCommandCenterHost => ({
            serverId: host.serverId,
            label: host.label,
          }),
        ),
        profiles,
        isSupported,
        labels: {
          section: t("shell.commandCenter.actions"),
          manageProfiles: t("shell.commandCenter.manageAgentProfiles"),
          manageProfilesForHost: (hostLabel) =>
            t("shell.commandCenter.agentProfilesForHost", { name: hostLabel }),
        },
        icons: {
          manage: ManageProfilesIcon,
          glyph: (profile) => agentProfileGlyphIcon(profile.icon, profile.color),
        },
        startAgentWithProfile,
        openAgentProfiles,
        openHostAgentProfiles,
      }),
    [
      hosts,
      isSupported,
      openAgentProfiles,
      openHostAgentProfiles,
      profiles,
      serverId,
      startAgentWithProfile,
      t,
    ],
  );

  useCommandCenterActions({ sourceId: "agent-profiles", enabled: hosts.length > 0, actions });
}

export function CommandCenterAgentProfileActions() {
  useAgentProfileCommandCenterActions();
  return null;
}
