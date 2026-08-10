export interface DesktopStartupDependencies {
  hasPendingGuiLaunchRequest: boolean;
  runCliPassthroughIfRequested: () => Promise<boolean>;
  inheritLoginShellEnv: () => void;
  reconcileLaunchAgent?: () => void;
  bootstrapGui: () => Promise<void>;
  autoUpdateInstalledSkills?: () => void;
}

export async function runDesktopStartup(deps: DesktopStartupDependencies): Promise<void> {
  if (!deps.hasPendingGuiLaunchRequest && (await deps.runCliPassthroughIfRequested())) {
    return;
  }

  deps.inheritLoginShellEnv();
  deps.reconcileLaunchAgent?.();
  await deps.bootstrapGui();
  deps.autoUpdateInstalledSkills?.();
}
