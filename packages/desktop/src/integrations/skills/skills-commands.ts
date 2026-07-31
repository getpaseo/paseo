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
import { coerceSkillSelection, type SkillSelectionStore } from "./selection-store.js";

/** Everything the settings UI needs to render skills in one round trip. */
export interface SkillsSnapshot extends SkillsStatus {
  selection: SkillSelection;
}

export function createSkillsCommandHandlers({
  resolveTargets,
  selectionStore,
}: {
  // Resolved per command, not at wiring time: the bundle path depends on how the
  // app was packaged, which is not knowable when handlers are registered.
  resolveTargets: () => SkillTargets;
  selectionStore: SkillSelectionStore;
}): Record<string, DesktopCommandHandler> {
  async function snapshot(
    apply: (targets: SkillTargets, selection: SkillSelection) => Promise<SkillsStatus>,
  ): Promise<SkillsSnapshot> {
    const selection = await selectionStore.get();
    return { ...(await apply(resolveTargets(), selection)), selection };
  }

  return {
    get_skills_status: () => snapshot(getSkillsStatus),
    install_skills: () => snapshot(installSkills),
    update_skills: () => snapshot(updateSkills),
    uninstall_skills: () => snapshot(uninstallSkills),
    save_skills_selection: async (args) => {
      // Converge before persisting. A save that cannot reach disk must leave no
      // preference behind, or the UI reports a failure while the next status
      // read and the next startup act on a selection the user never got.
      const selection = coerceSkillSelection(args);
      const status = await installSkills(resolveTargets(), selection);
      await selectionStore.set(selection);
      return { ...status, selection };
    },
  };
}
