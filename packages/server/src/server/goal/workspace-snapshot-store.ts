import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceSnapshot } from "./workspace-commit.js";

/**
 * Keeps the pre-task snapshot of a goal that works in the checkout on disk, so a daemon that
 * restarts between a task's success and its capture can still tell the task's files from the
 * person's. One small file per run, removed once the capture is done.
 */
export class WorkspaceSnapshotStore {
  constructor(private readonly dir: string) {}

  private file(goalId: string, runId: string): string {
    return path.join(this.dir, goalId, `${runId}.json`);
  }

  async save(goalId: string, runId: string, snapshot: WorkspaceSnapshot): Promise<void> {
    const target = this.file(goalId, runId);
    await mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.tmp`;
    await writeFile(temp, JSON.stringify(snapshot), "utf8");
    await rename(temp, target);
  }

  /** Null when none was kept for the run, or the file cannot be read. */
  async load(goalId: string, runId: string): Promise<WorkspaceSnapshot | null> {
    try {
      const parsed: unknown = JSON.parse(await readFile(this.file(goalId, runId), "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
      const entries = Object.entries(parsed);
      return entries.every(([, v]) => typeof v === "string")
        ? (Object.fromEntries(entries) as WorkspaceSnapshot)
        : null;
    } catch {
      return null;
    }
  }

  async remove(goalId: string, runId: string): Promise<void> {
    await rm(this.file(goalId, runId), { force: true });
  }
}
