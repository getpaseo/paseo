import { classifyGitMetadataPath } from "../git-metadata-event-rules.js";
import { resolve } from "node:path";
import { runGitCommand } from "../../utils/run-git-command.js";
import type { WorkspaceGitService } from "../workspace-git-service.js";
import { createFileObserver, type FileObserverSubscription } from "../file-observer/index.js";

export interface DiffDependencies {
  cwd: string;
  refs: string[];
  index: boolean;
  worktree: boolean;
}
// Own metadata observations here; comparison managers declare inputs rather than watching paths.
export class DiffDependencyObserver {
  private observer = createFileObserver();
  constructor(private workspaceGit: Pick<WorkspaceGitService, "requestWorkingTreeWatch">) {}
  async declareDependencies(
    input: DiffDependencies,
    changed: () => void,
  ): Promise<() => Promise<void>> {
    if (input.refs.length === 0 && !input.index && !input.worktree) return async () => {};
    let polling: ReturnType<typeof setInterval> | null = null;
    const subscriptions: FileObserverSubscription[] = [];
    let workingTree: Awaited<ReturnType<WorkspaceGitService["requestWorkingTreeWatch"]>> | null =
      null;
    try {
      const paths = await runGitCommand(["rev-parse", "--absolute-git-dir", "--git-common-dir"], {
        cwd: input.cwd,
      });
      const roots = new Set(
        paths.stdout
          .trim()
          .split("\n")
          .map((path) => resolve(input.cwd, path)),
      );
      for (const root of roots) {
        const subscription = await this.observer.subscribe(
          root,
          (error, events) => {
            if (error) {
              changed();
              polling ??= setInterval(changed, 5000);
              return;
            }
            const affectsInput = events.some((event) => {
              const path = event.path.slice(root.length + 1).replaceAll("\\", "/");
              if (path === "index") return input.index;
              return classifyGitMetadataPath("common", path).kind !== "ignore";
            });
            if (affectsInput) changed();
          },
          { ignore: [resolve(root, "objects"), resolve(root, "logs"), resolve(root, "hooks")] },
        );
        subscriptions.push(subscription);
      }
      if (input.worktree)
        workingTree = await this.workspaceGit.requestWorkingTreeWatch(input.cwd, changed);
      return async () => {
        if (polling) clearInterval(polling);
        await workingTree?.unsubscribe();
        await Promise.all(subscriptions.map((subscription) => subscription.unsubscribe()));
      };
    } catch (error) {
      if (polling) clearInterval(polling);
      await workingTree?.unsubscribe();
      await Promise.all(subscriptions.map((subscription) => subscription.unsubscribe()));
      throw error;
    }
  }
  getObservationCount(): number {
    return this.observer.getDiagnostics().activeObservationCount;
  }
  async close(): Promise<void> {
    await this.observer.close();
  }
}
