export interface DesktopStartupDependencies {
  hasPendingGuiLaunchRequest: boolean;
  runDaemonOnlyIfRequested: () => Promise<boolean>;
  runCliPassthroughIfRequested: () => Promise<boolean>;
  inheritLoginShellEnv: () => void;
  bootstrapGui: () => Promise<void>;
}

export async function runDesktopStartup(deps: DesktopStartupDependencies): Promise<void> {
  // Checked before the passthrough CLI, and regardless of any GUI launch
  // request: `--daemon-only` runs the app as a headless service, so it must
  // never fall through to a window or to the bundled CLI's argument parser.
  if (await deps.runDaemonOnlyIfRequested()) {
    return;
  }

  if (!deps.hasPendingGuiLaunchRequest && (await deps.runCliPassthroughIfRequested())) {
    return;
  }

  deps.inheritLoginShellEnv();
  await deps.bootstrapGui();
}
