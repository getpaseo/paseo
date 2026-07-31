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
const MAX_SAVE_ATTEMPTS = 3;

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
    let plan = await getSkillsStatus(targets, next);
    for (let attempt = 0; attempt < MAX_SAVE_ATTEMPTS; attempt += 1) {
      const removals = plan.ops.filter((op) => op.kind === "delete").map((op) => op.name);
      if (removals.some((name) => !confirmed.has(name))) {
        return {
          ...(await getSkillsStatus(targets, previous)),
          selection: previous,
          confirmationRequired: { removals },
        };
      }

      // Capture only paths this frozen plan can mutate. Capturing every managed
      // path would make rollback delete a new external directory that appeared
      // after the scan merely because it was absent from the snapshot.
      const transaction = await beginSkillsTransaction(targets, previous, next, plan.ops);
      let status: SkillsStatus;
      try {
        status = await installSkills(targets, next, {
          ...plan,
          // beginSkillsTransaction atomically staged these directories. Running
          // removeSkill afterward would delete a path another writer recreated.
          ops: plan.ops.filter((op) => op.kind !== "delete"),
        });
      } catch (error) {
        await transaction.rollback();
        throw error;
      }

      // An empty custom selection converges to the intentional not-installed
      // state; zero remaining operations is the invariant, not the label.
      if (status.ops.length === 0) {
        try {
          await selectionStore.set(next);
        } catch (error) {
          await transaction.rollback();
          throw error;
        }
        try {
          await transaction.commit();
        } catch {
          // Selection and disk convergence are already durable. The owned
          // manifest stays behind so the next serialized operation retries
          // cleanup; reporting this save as failed would misstate its outcome.
        }
        return { ...status, selection: next, confirmationRequired: null };
      }

      // The frozen plan became incomplete while it was being applied. Put only
      // its mutations back, rescan, and either request confirmation for a new
      // deletion or retry harmless additions/updates from the fresh plan.
      await transaction.rollback();
      plan = await getSkillsStatus(targets, next);
    }

    throw new Error("Skills changed repeatedly while the selection was being saved");
  }

  return {
    status: () => serialize(() => converge(getSkillsStatus)),
    install: () => serialize(() => converge(updateSkills)),
    update: () => serialize(() => converge(updateSkills)),
    uninstall: () => serialize(() => converge(uninstallSkills)),
    autoUpdate: () => serialize(() => converge(autoUpdateInstalledSkills)),
    save: (selection) => serialize(() => saveSelection(selection)),
  };
}
