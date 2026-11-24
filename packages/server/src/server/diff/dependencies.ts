import { resolve, relative } from "node:path";
import type { Logger } from "pino";
import { runGitCommand } from "../../utils/run-git-command.js";
import { createFileObserver, type FileObserverSubscription } from "../file-observer/index.js";
import {
  affectsGitDiffInterpretation,
  classifyGitMetadataPath,
  type GitMetadataScope,
} from "../git-metadata-event-rules.js";
import type { WorkspaceGitService } from "../workspace-git-service.js";
import type { RevisionWatch } from "./revision-probe.js";
import { pollDiffMetadata } from "./metadata-poll.js";

export interface DiffDependencies extends Omit<RevisionWatch, "changed" | "gitDirectory"> {
  movingRevision: boolean;
  index: boolean;
  worktree: boolean;
}

type MetadataListener = (paths: string[] | null) => void;
export interface DiffDependencySubscription {
  release(): Promise<void>;
  isPolling(): boolean;
}

interface MetadataObservation {
  listeners: Set<MetadataListener>;
  revisions: Set<RevisionWatch>;
  ready: Promise<void>;
  watcher?: FileObserverSubscription;
  poll?: ReturnType<typeof pollDiffMetadata>;
}

// Comparison managers declare inputs. This observer owns their shared Git metadata roots.
export class DiffDependencyObserver {
  private observer = createFileObserver();
  private roots = new Map<string, MetadataObservation>();

  constructor(
    private workspaceGit: Pick<WorkspaceGitService, "requestWorkingTreeWatch">,
    private logger?: Pick<Logger, "warn">,
  ) {}

  async declareDependencies(
    input: DiffDependencies,
    changed: (kind: "endpoints" | "interpretation") => void,
  ): Promise<DiffDependencySubscription> {
    const hasMutableEndpoints =
      input.movingRevision || input.checkoutBase !== undefined || input.index || input.worktree;
    const rootPaths = await runGitCommand(["rev-parse", "--absolute-git-dir", "--git-common-dir"], {
      cwd: input.cwd,
    });
    const [gitDir, commonDir] = rootPaths.stdout.split(/\r?\n/);
    if (!gitDir || !commonDir) throw new Error("Git returned incomplete metadata roots");
    const worktreeRoot = resolve(input.cwd, gitDir);
    const commonRoot = resolve(input.cwd, commonDir);
    const roots: [string, GitMetadataScope[]][] =
      commonRoot === worktreeRoot
        ? [[worktreeRoot, ["worktree", "common"]]]
        : [
            [worktreeRoot, ["worktree"]],
            [commonRoot, ["common"]],
          ];

    const metadata: DiffDependencySubscription[] = [];
    const releaseMetadata = async () => {
      await Promise.all(metadata.map((subscription) => subscription.release()));
    };
    try {
      for (const [root, scopes] of roots) {
        const isWorktree = scopes.includes("worktree");
        metadata.push(
          await this.observeMetadata(
            root,
            root === commonRoot
              ? { ...input, gitDirectory: worktreeRoot, changed: () => changed("endpoints") }
              : null,
            (paths) => {
              if (
                hasMutableEndpoints &&
                (paths === null ||
                  paths.some((path) => {
                    if (path === "index") return isWorktree && input.index;
                    if (path === "HEAD") return isWorktree;
                    return scopes.some(
                      (scope) => classifyGitMetadataPath(scope, path).kind !== "ignore",
                    );
                  }))
              ) {
                changed("endpoints");
              } else if (
                paths === null ||
                paths.some((path) =>
                  scopes.some((scope) => affectsGitDiffInterpretation(scope, path)),
                )
              ) {
                changed("interpretation");
              }
            },
          ),
        );
      }
      const workingTree = await this.workspaceGit.requestWorkingTreeWatch(input.cwd, () =>
        changed(input.worktree ? "endpoints" : "interpretation"),
      );
      return {
        isPolling: () => metadata.some((subscription) => subscription.isPolling()),
        async release() {
          try {
            workingTree.unsubscribe();
          } finally {
            await releaseMetadata();
          }
        },
      };
    } catch (error) {
      await releaseMetadata();
      throw error;
    }
  }

  private async observeMetadata(
    root: string,
    revisions: RevisionWatch | null,
    listener: MetadataListener,
  ): Promise<DiffDependencySubscription> {
    let observation = this.roots.get(root);
    if (!observation) {
      observation = { listeners: new Set(), revisions: new Set(), ready: Promise.resolve() };
      this.roots.set(root, observation);
      observation.ready = this.openMetadata(root, observation);
    }
    const current = observation;
    current.listeners.add(listener);
    if (revisions) current.revisions.add(revisions);
    await current.ready;
    return {
      isPolling: () => current.poll !== undefined,
      release: async () => {
        if (!current.listeners.delete(listener)) return;
        if (revisions) current.revisions.delete(revisions);
        if (current.listeners.size) return;
        this.roots.delete(root);
        await Promise.all([current.watcher?.unsubscribe(), current.poll?.close()]);
      },
    };
  }

  private async openMetadata(root: string, observation: MetadataObservation) {
    const notify: MetadataListener = (paths) => {
      for (const listener of observation.listeners) listener(paths);
    };
    const startPoll = (error: unknown) => {
      if (!observation.poll) {
        this.logger?.warn(
          { err: error, root },
          "Diff metadata watcher failed; using degraded polling",
        );
        let reported = false;
        observation.poll = pollDiffMetadata(root, observation.revisions, notify, (err, cwd) => {
          if (reported) return;
          reported = true;
          this.logger?.warn({ err, root, cwd }, "Failed to probe revisions for Changes");
        });
      }
      return observation.poll;
    };
    const recover = async (error: Error) => {
      // Resample the gap between the last watcher batch and the first poll.
      await startPoll(error).ready;
      notify(null);
    };

    try {
      observation.watcher = await this.observer.subscribe(
        root,
        (error, events) => {
          if (error) {
            void recover(error);
            return;
          }
          notify(events.map((event) => relative(root, event.path).replaceAll("\\", "/")));
        },
        { ignore: [resolve(root, "objects"), resolve(root, "logs"), resolve(root, "hooks")] },
      );
    } catch (error) {
      await startPoll(error).ready;
    }
  }

  getObservationCount(): number {
    return this.observer.getDiagnostics().activeObservationCount;
  }

  async close(): Promise<void> {
    await this.observer.close();
  }
}
