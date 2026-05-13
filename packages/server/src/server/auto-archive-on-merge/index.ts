import type { Logger } from "pino";

import { archiveIfSafe, type AutoArchiveArchiveOptions } from "./archive-if-safe.js";
import type { WorkspaceGitSubscription } from "../workspace-git-service.js";

export interface AutoArchiveOnMergeOptions extends AutoArchiveArchiveOptions {
  logger: Logger;
}

export function setupAutoArchiveOnMerge(
  options: AutoArchiveOnMergeOptions,
): WorkspaceGitSubscription {
  const log = options.logger.child({ module: "auto-archive-on-merge" });
  const inFlight = new Set<string>();

  return options.workspaceGitService.onSnapshotUpdated((snapshot) => {
    void archiveIfSafe({
      cwd: snapshot.cwd,
      pullRequest: snapshot.github.pullRequest,
      inFlight,
      options,
      log,
    });
  });
}
