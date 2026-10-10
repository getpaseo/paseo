import type { ForgeSpecificStatusFacts } from "./forge-service.js";

export interface GiteaStatusFacts {
  mergeable: boolean;
  hasMerged: boolean;
  ciStatus: string | null;
  autoMergeScheduled: boolean;
}

export type GiteaForgeSpecificStatusFacts = ForgeSpecificStatusFacts & {
  forge: "gitea";
} & GiteaStatusFacts;

export function isGiteaStatusFacts(
  facts: ForgeSpecificStatusFacts | null | undefined,
): facts is GiteaForgeSpecificStatusFacts {
  return facts?.forge === "gitea";
}
