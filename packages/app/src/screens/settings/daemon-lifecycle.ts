interface UnconfirmedTerminalProcess {
  pid: number;
  role: string;
  reason: string;
  detail: string;
}
interface WorkerStatus {
  pid: number;
  serverId: string;
  version: string | null;
  // Absent on daemons without terminalsSurviveRestart, which have no terminal cleanup to report.
  terminalCleanupUnconfirmed?: UnconfirmedTerminalProcess[];
}
interface StatusReader {
  getStatus: () => Promise<WorkerStatus>;
}

export interface SettingsDaemonRestartDeps extends StatusReader {
  restartServer: (reason: string, options: { killTerminals: boolean }) => Promise<unknown>;
}

/**
 * Acknowledgment starts the wait; only a different ready worker completes it. Terminals survive
 * the restart unless `killTerminals` is set (daemons advertising terminalsSurviveRestart); then
 * the replacement must also report every terminal process gone.
 */
export async function restartDaemonFromSettings(
  hostServerId: string,
  reason: string,
  deps: SettingsDaemonRestartDeps,
  options: { killTerminals: boolean } = { killTerminals: false },
): Promise<void> {
  const previous = await readSelectedWorker(hostServerId, deps);
  let acknowledged = false;
  try {
    await deps.restartServer(reason, options);
    acknowledged = true;
  } catch (error) {
    if (!isReconnectFailure(error)) throw error;
  }
  let replacement: WorkerStatus;
  try {
    replacement = await observeReplacement(previous, deps);
  } catch (error) {
    throw new Error(`Restart acknowledged: ${acknowledged}. ${String(error)}`, { cause: error });
  }
  const unconfirmed = replacement.terminalCleanupUnconfirmed ?? [];
  if (options.killTerminals && unconfirmed.length > 0) {
    throw new Error(
      [
        "The daemon restarted, but closing its terminals was not confirmed; these processes may still be running:",
        ...unconfirmed.map(
          (entry) => `pid ${entry.pid} (${entry.role}): ${entry.reason} (${entry.detail})`,
        ),
        "Stopping the daemon retries the cleanup.",
      ].join("\n"),
    );
  }
}

export async function updateDaemonFromSettings(
  hostServerId: string,
  deps: StatusReader & {
    updateDaemon: () => Promise<{
      success: boolean;
      error: string | null;
      newVersion: string | null;
    }>;
  },
): Promise<{ workerVersion: string }> {
  const previous = await readSelectedWorker(hostServerId, deps);
  const installed = await deps.updateDaemon();
  if (!installed.success) throw new Error(installed.error ?? "Package installation failed");
  try {
    const worker = await observeReplacement(previous, deps);
    if (!worker.version || !installed.newVersion || worker.version !== installed.newVersion) {
      throw new Error(
        `Expected installed version ${installed.newVersion ?? "unknown"}; observed worker ${worker.version}.`,
      );
    }
    return { workerVersion: worker.version };
  } catch (error) {
    throw new Error(
      `Package installed; replacement worker version was not confirmed. ${String(error)}`,
      { cause: error },
    );
  }
}

async function readSelectedWorker(serverId: string, deps: StatusReader): Promise<WorkerStatus> {
  const worker = await deps.getStatus();
  if (worker.serverId !== serverId) throw new Error("Daemon identity changed");
  return worker;
}

async function observeReplacement(
  previous: WorkerStatus,
  deps: StatusReader,
): Promise<WorkerStatus> {
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    try {
      const current = await readSelectedWorker(previous.serverId, deps);
      if (current.pid !== previous.pid) return current;
    } catch (error) {
      if (!isReconnectFailure(error)) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Replacement worker could not be confirmed. Check daemon status and logs.");
}

function isReconnectFailure(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    ["DAEMON_CONNECTION_LOST", "DAEMON_REQUEST_TIMEOUT"].includes(String(error.code)),
  );
}
