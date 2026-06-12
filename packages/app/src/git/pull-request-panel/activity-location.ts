import type { PrPaneActivity } from "./data";

export function formatPullRequestActivityLocation(activity: PrPaneActivity): string | null {
  if (!activity.location) {
    return null;
  }

  const parts = [formatPathAndLines(activity.location)];
  const threadState = formatThreadState(activity.location);
  if (threadState) {
    parts.push(...threadState);
  }
  const threadLabel = formatThreadLabel(activity.location.threadId);
  if (threadLabel) {
    parts.push(threadLabel);
  }

  return parts.join(" · ");
}

function formatPathAndLines(location: NonNullable<PrPaneActivity["location"]>): string {
  if (location.line !== undefined && location.startLine !== undefined) {
    return `${location.path}:${location.startLine}-${location.line}`;
  }
  if (location.line !== undefined) {
    return `${location.path}:${location.line}`;
  }
  return location.path;
}

/** Path-and-line label for a review thread header, e.g. "src/foo.ts:12-14". */
export function formatPullRequestThreadPath(
  location: NonNullable<PrPaneActivity["location"]>,
): string {
  return formatPathAndLines(location);
}

function formatThreadState(location: NonNullable<PrPaneActivity["location"]>): string[] | null {
  const state = [];
  if (location.isResolved !== undefined) {
    state.push(location.isResolved ? "resolved" : "unresolved");
  }
  if (location.isOutdated !== undefined) {
    state.push(location.isOutdated ? "outdated" : "current");
  }
  return state.length > 0 ? state : null;
}

function formatThreadLabel(threadId: string | undefined): string | null {
  if (!threadId || threadId.length > 24) {
    return null;
  }
  return `thread ${threadId}`;
}
