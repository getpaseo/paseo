import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { TreeKillTarget } from "./tree-kill.js";

const exec = promisify(execFile);
export interface ProviderProcessExit {
  kind: "provider_group";
  pid: number;
  processGroupId: number;
  observedAt: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

/** Capture while the owned child is alive; never guess a process group after restart. */
export async function detachedProcessGroup(child: TreeKillTarget): Promise<number | null> {
  if (process.platform === "win32" || !child.pid || child.pid <= 1) return null;
  try {
    const { stdout } = await exec("ps", ["-o", "pgid=", "-p", String(child.pid)], {
      timeout: 2_000,
    });
    return Number(stdout.trim()) === child.pid ? child.pid : null;
  } catch {
    return null;
  }
}
async function alive(group: number): Promise<boolean> {
  try {
    process.kill(-group, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if (process.platform === "darwin" && (error as NodeJS.ErrnoException).code === "EPERM") {
      // Darwin can deny a group probe while its last child is being reaped.
      // EPERM alone is not evidence of exit: inspect numeric membership.
      const { stdout } = await exec("ps", ["-axo", "pid=,pgid="], { timeout: 2_000 });
      return stdout.split("\n").some((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
        return match !== null && Number(match[2]) === group;
      });
    }
    throw error;
  }
}
async function waitForGroupExit(group: number, milliseconds: number): Promise<boolean> {
  const deadline = Date.now() + milliseconds;
  while (await alive(group)) {
    if (Date.now() >= deadline) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  return true;
}
/** An interrupt is insufficient: wait for the owned Unix group and root exit event. */
export async function terminateDetachedGroup(
  child: TreeKillTarget,
  group: number,
): Promise<ProviderProcessExit> {
  if (!child.pid || group !== child.pid || group <= 1)
    throw new Error("Invalid owned process group");
  if (await alive(group)) {
    try {
      process.kill(-group, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    if (!(await waitForGroupExit(group, 2_000))) {
      try {
        process.kill(-group, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      if (!(await waitForGroupExit(group, 1_000)))
        throw new Error("Provider process group exit is unconfirmed");
    }
  }
  const deadline = Date.now() + 1_000;
  while (child.exitCode == null && child.signalCode == null) {
    if (Date.now() >= deadline) throw new Error("Provider root process exit is unconfirmed");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  return {
    kind: "provider_group",
    pid: child.pid,
    processGroupId: group,
    observedAt: new Date().toISOString(),
    exitCode: child.exitCode ?? null,
    signal: child.signalCode ?? null,
  };
}
