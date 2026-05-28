export interface WorkspaceOpenTargetAvailability {
  requiresLocalDaemon: boolean;
}

export function filterTargetsForDaemonLocation<Target extends WorkspaceOpenTargetAvailability>(
  targets: readonly Target[],
  input: { isLocalDaemon: boolean },
): Target[] {
  if (input.isLocalDaemon) {
    return [...targets];
  }
  return targets.filter((target) => !target.requiresLocalDaemon);
}
