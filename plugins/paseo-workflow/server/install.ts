import { profiles } from "../shared/profiles";
import type { PaseoConfigActions } from "./types";

export async function installProfiles(config: PaseoConfigActions) {
  return config.patch({ addAgentProfilesIfMissing: profiles });
}
