import { watch } from "node:fs";
import type { SubscriptionInput } from "@getpaseo/plugin";
import { execCommand } from "@getpaseo/plugin/server";
import type { ChangedFile, diffWatch } from "../shared/diff";

const SETTLE_MS = 150;

const STATUSES: Record<string, ChangedFile["status"]> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
};

/** Lists changed files the way `git diff --name-status` does, plus untracked files. */
export async function readChangedFiles({
  cwd,
  from,
  to,
}: SubscriptionInput<typeof diffWatch>): Promise<ChangedFile[]> {
  const range = to ? [from, to] : [from];
  const { stdout } = await execCommand("git", ["diff", "--name-status", "-z", ...range], { cwd });
  const files = parseNameStatus(stdout);
  if (!to) {
    const untracked = await execCommand(
      "git",
      ["ls-files", "--others", "--exclude-standard", "-z"],
      {
        cwd,
      },
    );
    for (const path of untracked.stdout.split("\0").filter(Boolean))
      files.push({ path, status: "added" });
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function parseNameStatus(output: string): ChangedFile[] {
  const fields = output.split("\0").filter(Boolean);
  const files: ChangedFile[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const code = fields[index][0];
    // Renames carry the old path before the new one.
    if (code === "R") index += 1;
    const path = fields[index + 1];
    index += 1;
    if (path) files.push({ path, status: STATUSES[code] ?? "modified" });
  }
  return files;
}

/** Resolves each time the directory settles after a change, and with false once `signal` aborts. */
export function watchDirectory(cwd: string, signal: AbortSignal) {
  let changed = true;
  let wake: (() => void) | null = null;
  const watcher = watch(cwd, { recursive: true }, () => {
    changed = true;
    wake?.();
  });
  signal.addEventListener(
    "abort",
    () => {
      watcher.close();
      wake?.();
    },
    { once: true },
  );
  return {
    async settled(): Promise<boolean> {
      // The watcher and the abort both wake a wait.
      if (!changed && !signal.aborted) await new Promise<void>((resolve) => (wake = resolve));
      wake = null;
      if (signal.aborted) return false;
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
      changed = false;
      return !signal.aborted;
    },
  };
}
