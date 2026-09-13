import type { PaseoConfigActions } from "@getpaseo/client";
import { profiles } from "../shared/profiles";

export async function installProfiles(config: PaseoConfigActions) {
  return config.patch({ addAgentProfilesIfMissing: profiles });
}
