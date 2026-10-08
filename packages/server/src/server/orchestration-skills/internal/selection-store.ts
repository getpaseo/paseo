import type { AgentSkillSelection } from "@getpaseo/protocol/messages";

import type { DaemonConfigStore } from "../../daemon-config-store.js";

export type SkillSelection = AgentSkillSelection;

export interface SkillSelectionStore {
  get(profileId?: string): Promise<SkillSelection>;
  set(selection: unknown, profileId?: string): Promise<SkillSelection>;
  isSet(): Promise<boolean>;
}

const DEFAULT_SKILL_SELECTION: SkillSelection = { mode: "all" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function coerceSkillNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const names = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return [...new Set(names)].sort();
}

export function coerceSkillSelection(value: unknown): SkillSelection {
  if (!isRecord(value)) return DEFAULT_SKILL_SELECTION;
  if (value.mode === "all") return { mode: "all" };
  if (value.mode === "custom") {
    return { mode: "custom", skills: coerceSkillNames(value.skills) };
  }
  return DEFAULT_SKILL_SELECTION;
}

export function createSkillSelectionStore(
  configStore: Pick<DaemonConfigStore, "get" | "patch" | "setAgentSkillSelection">,
): SkillSelectionStore {
  return {
    async get(profileId) {
      if (!profileId) return coerceSkillSelection(configStore.get().skills?.selection);
      const profile = configStore
        .get()
        .agentSettingsProfiles?.profiles.find((candidate) => candidate.id === profileId);
      if (!profile) throw new Error("Agent settings profile does not exist");
      return coerceSkillSelection(profile.settings.skills?.selection);
    },
    async set(selection, profileId) {
      const parsed = coerceSkillSelection(selection);
      if (profileId) {
        configStore.patch({
          agentSettingsProfilePatch: { profileId, skills: { selection: parsed } },
        });
      } else {
        configStore.setAgentSkillSelection(parsed);
      }
      return parsed;
    },
    async isSet() {
      return configStore.get().skills?.selection !== undefined;
    },
  };
}
