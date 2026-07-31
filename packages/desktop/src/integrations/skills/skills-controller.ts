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
    const committed = await selectionStore.get();
    const next = coerceSkillSelection(input);
    try {
      const status = await installSkills(targets, next);
      await selectionStore.set(next);
      return { ...status, selection: next };
    } catch (error) {
      // Nothing was committed, so leave the machine as Cancel would: put the
      // managed directories back to what the committed selection describes.
      // Best effort — if the disk is broken enough that this fails too, the
      // original failure is still what the user needs to see.
      await installSkills(targets, committed).catch(() => undefined);
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
