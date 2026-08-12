export type PinnedTabTarget =
  | { kind: "draft" }
  | { kind: "terminal" }
  | { kind: "browser" }
  | { kind: "working_diff" }
  | { kind: "files" }
  | { kind: "pull_request" }
  | { kind: "profile"; profileId: string };

export function isPinnedTargetAvailable(
  target: PinnedTabTarget,
  environment: { isElectron: boolean; isGit?: boolean; hasPullRequest?: boolean },
): boolean {
  if (target.kind === "browser") {
    return environment.isElectron;
  }
  if (target.kind === "working_diff") {
    return environment.isGit !== false;
  }
  if (target.kind === "pull_request") {
    return environment.hasPullRequest !== false;
  }
  return true;
}

export function pinnedTargetKey(target: PinnedTabTarget): string {
  if (target.kind === "profile") {
    return `profile:${target.profileId}`;
  }
  return target.kind;
}

export function isTargetPinned(
  pinned: readonly PinnedTabTarget[],
  target: PinnedTabTarget,
): boolean {
  const key = pinnedTargetKey(target);
  return pinned.some((entry) => pinnedTargetKey(entry) === key);
}

export function togglePinnedTarget(
  pinned: readonly PinnedTabTarget[],
  target: PinnedTabTarget,
): PinnedTabTarget[] {
  const key = pinnedTargetKey(target);
  const next = pinned.filter((entry) => pinnedTargetKey(entry) !== key);
  if (next.length === pinned.length) {
    next.push(target);
  }
  return next;
}
