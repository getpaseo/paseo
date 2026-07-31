import { app } from "electron";

import {
  autoUpdateInstalledSkills as autoUpdateSkillsForSelection,
  type SkillsStatus,
  type SkillTargets,
} from "./operations.js";
import {
  getAgentsSkillsDir,
  getBundledSkillsDir,
  getClaudeSkillsDir,
  getCodexSkillsDir,
} from "./paths.js";
import { createSkillSelectionStore, type SkillSelectionStore } from "./selection-store.js";

export { createSkillsCommandHandlers, type SkillsSnapshot } from "./skills-commands.js";
export type {
  SkillOp,
  SkillSelection,
  SkillsState,
  SkillsStatus,
  SkillTargets,
} from "./operations.js";

let selectionStore: SkillSelectionStore | null = null;

export function getSkillTargets(): SkillTargets {
  return {
    sourceDir: getBundledSkillsDir(),
    agentsDir: getAgentsSkillsDir(),
    claudeDir: getClaudeSkillsDir(),
    codexDir: getCodexSkillsDir(),
  };
}

export function getSkillSelectionStore(): SkillSelectionStore {
  selectionStore ??= createSkillSelectionStore({ userDataPath: app.getPath("userData") });
  return selectionStore;
}

/** Startup convergence: keep whatever the user selected in sync with the bundle. */
export async function autoUpdateInstalledSkills(): Promise<SkillsStatus> {
  const selection = await getSkillSelectionStore().get();
  return autoUpdateSkillsForSelection(getSkillTargets(), selection);
}
