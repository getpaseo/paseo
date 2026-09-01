import { execFile, spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { once } from "node:events";

/**
 * Runs a repo-local TypeScript entrypoint through Node's own tsx loader instead
 * of the `node_modules/.bin/tsx` shim.
 *
 * The shim is a platform trap, not a convenience: on Windows it is `tsx.cmd`,
 * and Node refuses to spawn `.cmd`/`.bat` without `shell: true` (EINVAL, from
 * the CVE-2024-27980 mitigation). Opting into `shell: true` to get around that
 * trades one bug for three — argv is concatenated unescaped (DEP0190), a path
 * containing spaces splits, and the kill signal lands on `cmd.exe` while the
 * real child keeps the port. Spawning `process.execPath` has none of those
 * properties and is byte-identical on POSIX, so there is no platform branch.
 */
export function spawnTsx(entrypoint: string, args: string[], options: SpawnOptions): ChildProcess {
  if (entrypoint.startsWith("-")) {
    throw new Error(`TypeScript entrypoint must be a path, received ${entrypoint}`);
  }
  return spawn(process.execPath, ["--import", "tsx", "--", entrypoint, ...args], options);
}

/**
 * Terminates a child and everything it forked, then waits for the exit.
 *
 * `child.kill()` on Windows maps to `TerminateProcess` against the direct child
 * only. Metro and the daemon supervisor both fork workers, so the signal leaves
 * grandchildren holding the listening port and the next run fails to bind.
 * `taskkill /T` walks the tree; POSIX keeps the SIGTERM-then-SIGKILL ladder.
 */
export async function killProcessTree(child: ChildProcess | null): Promise<void> {
  if (!child || hasExited(child)) return;
  const exited = once(child, "exit").then(() => undefined);

  if (process.platform === "win32") {
    const pid = child.pid;
    if (pid === undefined) {
      throw new Error("Cannot terminate a Windows process tree without a PID");
    }

    // Register the exit listener before taskkill to avoid missing a fast exit.
    // Bound taskkill itself so a stuck system utility cannot hang teardown.
    const completed = Promise.withResolvers<Error | null>();
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { timeout: 5_000 }, (error) =>
      completed.resolve(error),
    );
    const taskkillError = await completed.promise;
    if (taskkillError && !hasExited(child)) {
      try {
        child.kill("SIGKILL");
      } catch {
        // The child can exit between the state check and the direct kill.
      }
      await waitForExitOrTimeout(exited, 5_000);
      throw new Error(`Failed to terminate process tree for PID ${pid}`, { cause: taskkillError });
    }
    if (!hasExited(child) && !(await waitForExitOrTimeout(exited, 5_000))) {
      throw new Error(`Process tree for PID ${pid} did not exit after taskkill`);
    }
    return;
  }

  child.kill("SIGTERM");
  if (await waitForExitOrTimeout(exited, 5_000)) return;

  child.kill("SIGKILL");
  if (!(await waitForExitOrTimeout(exited, 5_000))) {
    throw new Error(`Process ${String(child.pid)} did not exit after SIGKILL`);
  }
}

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForExitOrTimeout(exited: Promise<void>, timeoutMs: number): Promise<boolean> {
  const timedOut = Promise.withResolvers<boolean>();
  const timeout = setTimeout(() => timedOut.resolve(false), timeoutMs);
  try {
    return await Promise.race([exited.then(() => true), timedOut.promise]);
  } finally {
    clearTimeout(timeout);
  }
}
