import { WorkspaceGitWatcherSubscriptionTimeoutError } from "./workspace-git-service.js";

/**
 * A rejection that concerns one workspace's watcher. The service already degrades that workspace
 * to polling, so the worker keeps running instead of dropping every agent for it.
 */
export function isRecoverableRejection(reason: unknown): boolean {
  return reason instanceof WorkspaceGitWatcherSubscriptionTimeoutError;
}
