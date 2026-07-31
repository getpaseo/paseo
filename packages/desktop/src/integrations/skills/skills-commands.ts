import type { DesktopCommandHandler } from "../../settings/desktop-settings-commands.js";
import {
  getSkillsStatus,
  installSkills,
  type SkillSelection,
  type SkillsStatus,
  type SkillTargets,
  uninstallSkills,
  updateSkills,
} from "./operations.js";
import type { SkillSelectionStore } from "./selection-store.js";

/** Everything the settings UI needs to render skills in one round trip. */
export interface SkillsSnapshot extends SkillsStatus {
  selection: SkillSelection;
}

export function createSkillsCommandHandlers({
  targets,
  selectionStore,
}: {
  targets: SkillTargets;
  selectionStore: SkillSelectionStore;
}): Record<string, DesktopCommandHandler> {
  async function snapshot(
    apply: (selection: SkillSelection) => Promise<SkillsStatus>,
  ): Promise<SkillsSnapshot> {
    const selection = await selectionStore.get();
    return { ...(await apply(selection)), selection };
  }

  return {
    get_skills_status: () => snapshot((selection) => getSkillsStatus(targets, selection)),
    install_skills: () => snapshot((selection) => installSkills(targets, selection)),
    update_skills: () => snapshot((selection) => updateSkills(targets, selection)),
    uninstall_skills: () => snapshot((selection) => uninstallSkills(targets, selection)),
    save_skills_selection: async (args) => {
      const selection = await selectionStore.set(args);
      return { ...(await installSkills(targets, selection)), selection };
    },
  };
}
