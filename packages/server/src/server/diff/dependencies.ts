import {
  affectsGitDiffInterpretation,
  classifyGitMetadataPath,
  type GitMetadataScope,
} from "../git-metadata-event-rules.js";
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
    changed: (kind: "endpoints" | "interpretation") => void,
  ): Promise<() => Promise<void>> {
    const hasMutableEndpoints = input.refs.length > 0 || input.index || input.worktree;
    let polling: ReturnType<typeof setInterval> | null = null;
    const subscriptions: FileObserverSubscription[] = [];
    let workingTree: Awaited<ReturnType<WorkspaceGitService["requestWorkingTreeWatch"]>> | null =
      null;
    try {
      const paths = await runGitCommand(["rev-parse", "--absolute-git-dir", "--git-common-dir"], {
        cwd: input.cwd,
      });
      const [gitDir, commonDir] = paths.stdout.split(/\r?\n/);
      if (!gitDir || !commonDir) throw new Error("Git returned incomplete metadata roots");
      const roots = new Map<string, GitMetadataScope[]>();
      for (const [directory, scope] of [
        [gitDir, "worktree"],
        [commonDir, "common"],
      ] as const) {
        const root = resolve(input.cwd, directory);
        const scopes = roots.get(root) ?? [];
        scopes.push(scope);
        roots.set(root, scopes);
      }
      for (const [root, scopes] of roots) {
        const subscription = await this.observer.subscribe(
          root,
          (error, events) => {
            if (error) {
              changed("endpoints");
              polling ??= setInterval(() => changed("endpoints"), 5000);
              return;
            }
            let interpretation = false;
            const endpoints = events.some((event) => {
              const path = event.path.slice(root.length + 1).replaceAll("\\", "/");
              if (scopes.some((scope) => affectsGitDiffInterpretation(scope, path)))
                interpretation = true;
              if (!hasMutableEndpoints) return false;
              if (path === "index") return input.index;
              return scopes.some((scope) => classifyGitMetadataPath(scope, path).kind !== "ignore");
            });
            if (endpoints) changed("endpoints");
            else if (interpretation) changed("interpretation");
          },
          { ignore: [resolve(root, "objects"), resolve(root, "logs"), resolve(root, "hooks")] },
        );
        subscriptions.push(subscription);
      }
      workingTree = await this.workspaceGit.requestWorkingTreeWatch(input.cwd, () =>
        changed(input.worktree ? "endpoints" : "interpretation"),
      );
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
