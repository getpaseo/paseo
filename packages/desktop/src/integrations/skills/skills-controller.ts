import {
  autoUpdateInstalledSkills,
  getSkillsStatus,
  installSkills,
  type SkillSelection,
  type SkillsStatus,
  type SkillTargets,
  uninstallSkills,
  updateSkills,
} from "./operations.js";
import { coerceSkillSelection, type SkillSelectionStore } from "./selection-store.js";
import { beginSkillsTransaction, discardOrphanedSkillStaging } from "./skills-transaction.js";

/** Everything the settings UI needs to render skills in one round trip. */
export interface SkillsSnapshot extends SkillsStatus {
  selection: SkillSelection;
}

export interface SkillsController {
  status(): Promise<SkillsSnapshot>;
  install(): Promise<SkillsSnapshot>;
  update(): Promise<SkillsSnapshot>;
  uninstall(): Promise<SkillsSnapshot>;
  autoUpdate(): Promise<SkillsSnapshot>;
  save(selection: unknown): Promise<SkillsSnapshot>;
}

type Converge = (targets: SkillTargets, selection: SkillSelection) => Promise<SkillsStatus>;

/**
 * The single writer for installed skills. Startup convergence and every settings
 * command run through one queue, so no operation applies a plan computed from a
 * selection another one has already replaced, and no read sees a half-applied
 * directory. Ordering between concurrent callers is not promised — consistency
 * after both finish is.
 */
export function createSkillsController({
  resolveTargets,
  selectionStore,
}: {
  // Resolved per operation, not at wiring time: the bundle path depends on how
  // the app was packaged, which is not knowable when the controller is built.
  resolveTargets: () => SkillTargets;
  selectionStore: SkillSelectionStore;
}): SkillsController {
  let queue: Promise<unknown> = Promise.resolve();

  function serialize<T>(run: () => Promise<T>): Promise<T> {
    const next = queue.then(run, run);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async function converge(apply: Converge): Promise<SkillsSnapshot> {
    const selection = await selectionStore.get();
    return { ...(await apply(resolveTargets(), selection)), selection };
  }

  async function saveSelection(input: unknown): Promise<SkillsSnapshot> {
    const targets = resolveTargets();
    const next = coerceSkillSelection(input);
    // Convergence deletes whole skill directories, so the only way a failed save
    // can leave the machine as Cancel would is to hold the exact directories
    // first. Re-installing the committed selection would rebuild the bundled
    // files and lose whatever the user had put inside them.
    await discardOrphanedSkillStaging(targets);
    const transaction = await beginSkillsTransaction(targets);
    try {
      const status = await installSkills(targets, next);
      await selectionStore.set(next);
      await transaction.commit();
      return { ...status, selection: next };
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }

  return {
    status: () => serialize(() => converge(getSkillsStatus)),
    install: () => serialize(() => converge(installSkills)),
    update: () => serialize(() => converge(updateSkills)),
    uninstall: () => serialize(() => converge(uninstallSkills)),
    autoUpdate: () => serialize(() => converge(autoUpdateInstalledSkills)),
    save: (selection) => serialize(() => saveSelection(selection)),
  };
}
