export const DAEMON_ONLY_FLAG = "--daemon-only";

const GRACEFUL_STOP_SIGNAL: NodeJS.Signals = "SIGTERM";
const FORCED_STOP_SIGNAL: NodeJS.Signals = "SIGKILL";
const SERVICE_ENV_PREFIX = "PASEO_";

export interface DaemonOnlyChildProcess {
  once(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
  kill(signal: NodeJS.Signals): unknown;
}

export interface RunDaemonOnlyDeps {
  spawnDaemon: () => DaemonOnlyChildProcess;
  /**
   * Registers the shutdown trigger. Electron is the only thing that hears a
   * stop request here: Chromium's browser process handles SIGTERM/SIGINT itself
   * and exits without ever running Node's `process.on("SIGTERM")` listeners, so
   * `app.on("before-quit")` is the signal, and this hook owns deferring the
   * quit until the daemon is actually down.
   */
  onStopRequested: (requestStop: () => void) => void;
  onSpawnError: (error: Error) => void;
}

/**
 * Inherits the login shell's environment (agents need the PATH a shell would
 * give them, and a service started at boot has no shell to inherit from) while
 * keeping the configuration the service manager passed in.
 *
 * The login shell wins every other key by design, but `Environment=` and
 * `EnvironmentFile=` in a unit are deliberate configuration. A shell rc that
 * exports PASEO_HOME for interactive CLI use would otherwise silently move the
 * daemon to a different home, taking every agent and project with it.
 */
export function inheritLoginShellEnvForService(input: {
  env: NodeJS.ProcessEnv;
  inheritLoginShellEnv: () => void;
}): void {
  const serviceConfig: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(input.env)) {
    if (key.startsWith(SERVICE_ENV_PREFIX) && value !== undefined) {
      serviceConfig[key] = value;
    }
  }

  input.inheritLoginShellEnv();

  Object.assign(input.env, serviceConfig);
}

export function isDaemonOnlyLaunch(input: { argv: string[]; isDefaultApp: boolean }): boolean {
  return input.argv.slice(input.isDefaultApp ? 2 : 1).includes(DAEMON_ONLY_FLAG);
}

export function isDaemonOnlyLaunchFromArgv(argv: string[]): boolean {
  return isDaemonOnlyLaunch({ argv, isDefaultApp: process.defaultApp });
}

/**
 * A daemon killed by the signal we sent it stopped because we asked it to, so
 * the service exits 0. A daemon that dies from anything else crashed, and a
 * service supervisor should see that as a failure worth restarting.
 */
export function resolveDaemonOnlyExitCode(input: {
  code: number | null;
  signal: NodeJS.Signals | null;
  requestedStopSignal: NodeJS.Signals | null;
}): number {
  if (typeof input.code === "number") {
    return input.code;
  }
  return input.signal !== null && input.signal === input.requestedStopSignal ? 0 : 1;
}

/**
 * Runs the bundled daemon in the foreground and stays alive for as long as it
 * does, so the packaged app can be a service unit's main process.
 */
export async function runDaemonOnly(deps: RunDaemonOnlyDeps): Promise<number> {
  const child = deps.spawnDaemon();
  const stop: { requestedSignal: NodeJS.Signals | null } = { requestedSignal: null };

  // A repeated stop escalates, so a second Ctrl-C is not a no-op when a daemon
  // refuses to shut down. Past the second request there is nothing left to try.
  deps.onStopRequested(() => {
    if (stop.requestedSignal === null) {
      stop.requestedSignal = GRACEFUL_STOP_SIGNAL;
      child.kill(GRACEFUL_STOP_SIGNAL);
      return;
    }
    if (stop.requestedSignal === GRACEFUL_STOP_SIGNAL) {
      stop.requestedSignal = FORCED_STOP_SIGNAL;
      child.kill(FORCED_STOP_SIGNAL);
    }
  });

  return await new Promise<number>((resolve) => {
    child.once("error", (error) => {
      deps.onSpawnError(error);
      resolve(1);
    });
    child.once("exit", (code, signal) => {
      resolve(
        resolveDaemonOnlyExitCode({
          code,
          signal,
          requestedStopSignal: stop.requestedSignal,
        }),
      );
    });
  });
}
