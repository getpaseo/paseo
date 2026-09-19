import type { AgentProfile } from "@getpaseo/protocol/messages";
import type { CommandCenterContribution, CommandCenterIcon } from "./contributions";

export interface AgentProfileCommandCenterHost {
  serverId: string;
  label: string;
}

export interface AgentProfileCommandCenterLabels {
  section: string;
  manageProfiles: string;
  manageProfilesForHost(hostLabel: string): string;
}

export interface AgentProfileCommandCenterIcons {
  manage?: CommandCenterIcon;
  glyph?(profile: Pick<AgentProfile, "icon" | "color">): CommandCenterIcon | undefined;
}

export interface AgentProfileCommandCenterSource {
  /**
   * The host the palette acts on: the active workspace's host, else the last
   * visited workspace's host, else the only connected host. Null when several
   * hosts are connected and none is selected — the palette then offers one
   * manage entry per host instead of guessing whose profiles to list.
   */
  serverId: string | null;
  hosts: readonly AgentProfileCommandCenterHost[];
  /** Null while the daemon config loads; an empty list when the host has none. */
  profiles: readonly AgentProfile[] | null;
  /** False on daemons that predate agent profiles, or while disconnected. */
  isSupported: boolean;
  labels: AgentProfileCommandCenterLabels;
  icons: AgentProfileCommandCenterIcons;
  startAgentWithProfile(profileId: string): void;
  openAgentProfiles(): void;
  openHostAgentProfiles(serverId: string): void;
}

function buildStartContribution(
  source: AgentProfileCommandCenterSource,
  profile: AgentProfile,
  rank: number,
): CommandCenterContribution {
  const keywords = ["agent", "profile", "new", "start", "launch", profile.name, profile.provider];
  const model = profile.model?.trim();
  if (model) {
    keywords.push(model);
  }
  return {
    id: `agent-profile:start:${profile.id}`,
    group: "actions",
    groupRank: 0,
    rank,
    keywords,
    visibility: "query",
    run: () => source.startAgentWithProfile(profile.id),
    presentation: {
      kind: "action",
      title: profile.name,
      sectionTitle: source.labels.section,
      icon: source.icons.glyph?.(profile),
    },
  };
}

function buildManageContribution(
  source: AgentProfileCommandCenterSource,
  input: { id: string; rank: number; title: string; run: () => void },
): CommandCenterContribution {
  return {
    id: input.id,
    group: "actions",
    groupRank: 0,
    rank: input.rank,
    keywords: ["agent", "profile", "profiles", "manage", "settings", "config", "configure"],
    visibility: "query",
    run: input.run,
    presentation: {
      kind: "action",
      title: input.title,
      sectionTitle: source.labels.section,
      icon: source.icons.manage,
    },
  };
}

/**
 * Agent profiles in the command palette. Profiles are host config, so the list
 * only renders once a single host resolves; with several hosts and no
 * selection the palette offers one manage entry per host rather than merging
 * lists whose identical names would collide. Loading and legacy daemons omit
 * the group instead of showing entries that cannot act — the same rule the
 * workspace label catalog follows.
 */
export function buildAgentProfileCommandCenterContributions(
  source: AgentProfileCommandCenterSource,
): CommandCenterContribution[] {
  if (source.hosts.length === 0) {
    return [];
  }

  if (!source.serverId) {
    return source.hosts.map((host, index) =>
      buildManageContribution(source, {
        id: `agent-profile:manage:${host.serverId}`,
        rank: 9 + index,
        title: source.labels.manageProfilesForHost(host.label),
        run: () => source.openHostAgentProfiles(host.serverId),
      }),
    );
  }

  if (!source.isSupported || source.profiles === null) {
    return [];
  }

  const contributions = source.profiles.map((profile, index) =>
    buildStartContribution(source, profile, 9 + index),
  );
  contributions.push(
    buildManageContribution(source, {
      id: "agent-profile:manage",
      rank: 40,
      title: source.labels.manageProfiles,
      run: source.openAgentProfiles,
    }),
  );
  return contributions;
}
