import type { BackgroundTaskStatus } from "./store.js";
import { isTerminalBackgroundTaskStatus } from "./store.js";

/**
 * Decide whether a log poll should end the subscription.
 * Running tasks never EOF just because the file has no new bytes or the path
 * is not known yet — otherwise we permanently stop tailing mid-run.
 */
export function resolveBackgroundTaskOutputEof(input: {
  taskStatus: BackgroundTaskStatus | null;
  hasOutputFile: boolean;
  caughtUp: boolean;
}): boolean {
  if (input.taskStatus === null) {
    return true;
  }
  if (!isTerminalBackgroundTaskStatus(input.taskStatus)) {
    return false;
  }
  if (!input.hasOutputFile) {
    return true;
  }
  return input.caughtUp;
}
