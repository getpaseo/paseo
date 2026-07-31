import { app } from "electron";

import type { SkillsStatus, SkillTargets } from "./operations.js";
import {
  getAgentsSkillsDir,
  getBundledSkillsDir,
  getClaudeSkillsDir,
  getCodexSkillsDir,
} from "./paths.js";
import { createSkillSelectionStore } from "./selection-store.js";
import { createSkillsController, type SkillsController } from "./skills-controller.js";

export { createSkillsCommandHandlers } from "./skills-commands.js";
export { type SkillsController, type SkillsSnapshot } from "./skills-controller.js";
export type {
  SkillOp,
  SkillSelection,
  SkillsState,
  SkillsStatus,
  SkillTargets,
} from "./operations.js";

let controller: SkillsController | null = null;

function getSkillTargets(): SkillTargets {
  return {
    sourceDir: getBundledSkillsDir(),
    agentsDir: getAgentsSkillsDir(),
    claudeDir: getClaudeSkillsDir(),
    codexDir: getCodexSkillsDir(),
  };
}

/**
 * One controller per process. Startup convergence and the settings commands must
 * share it, or they are two writers over the same directories again.
 */
export function getSkillsController(): SkillsController {
  controller ??= createSkillsController({
    resolveTargets: getSkillTargets,
    selectionStore: createSkillSelectionStore({ userDataPath: app.getPath("userData") }),
  });
  return controller;
}

/** Startup convergence: keep whatever the user selected in sync with the bundle. */
export async function autoUpdateInstalledSkills(): Promise<SkillsStatus> {
  return getSkillsController().autoUpdate();
}
