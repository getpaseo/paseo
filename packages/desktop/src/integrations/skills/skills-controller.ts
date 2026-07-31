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
import {
  coerceSkillNames,
  coerceSkillSelection,
  type SkillSelectionStore,
} from "./selection-store.js";
import {
  beginSkillsTransaction,
  recoverInterruptedSkillTransactions,
} from "./skills-transaction.js";

/** Everything the settings UI needs to render skills in one round trip. */
export interface SkillsSnapshot extends SkillsStatus {
  selection: SkillSelection;
}

export interface SkillsSaveResult extends SkillsSnapshot {
  /**
   * Non-null when the save did nothing because these directories would be
   * deleted and the request had not confirmed them. Retry with the names.
   */
  confirmationRequired: { removals: string[] } | null;
}

export interface SkillsController {
  status(): Promise<SkillsSnapshot>;
  install(): Promise<SkillsSnapshot>;
  update(): Promise<SkillsSnapshot>;
  uninstall(): Promise<SkillsSnapshot>;
  autoUpdate(): Promise<SkillsSnapshot>;
  save(request: unknown): Promise<SkillsSaveResult>;
}

type Converge = (targets: SkillTargets, selection: SkillSelection) => Promise<SkillsStatus>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
    await recoverInterruptedSkillTransactions(resolveTargets(), selection);
    return { ...(await apply(resolveTargets(), selection)), selection };
  }

  async function saveSelection(request: unknown): Promise<SkillsSaveResult> {
    const targets = resolveTargets();
    const next = coerceSkillSelection(request);
    const previous = await selectionStore.get();
    await recoverInterruptedSkillTransactions(targets, previous);
    const confirmed = new Set(
      coerceSkillNames(isRecord(request) ? request.confirmedRemovals : null),
    );

    // The plan comes from a scan taken here, inside the queue, and is the exact
    // plan applied below. Deciding what will be deleted from an older snapshot
    // leaves a window for a directory to appear and be deleted unannounced.
    const plan = await getSkillsStatus(targets, next);
    const removals = plan.ops.filter((op) => op.kind === "delete").map((op) => op.name);
    if (removals.some((name) => !confirmed.has(name))) {
      return {
        ...(await getSkillsStatus(targets, previous)),
        selection: previous,
        confirmationRequired: { removals },
      };
    }

    // Convergence deletes whole skill directories, so the only way a failed save
    // can leave the machine as Cancel would is to hold the exact directories
    // first. Re-installing the committed selection would rebuild the bundled
    // files and lose whatever the user had put inside them.
    const transaction = await beginSkillsTransaction(targets, previous, next);
    try {
      const status = await installSkills(targets, next, plan);
      await selectionStore.set(next);
      await transaction.commit();
      return { ...status, selection: next, confirmationRequired: null };
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
