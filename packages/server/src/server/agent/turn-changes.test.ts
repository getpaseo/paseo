import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { listComparison } from "../diff/git.js";
import { captureTurnWorktree, retainPendingTurnStart, retainTurnChanges } from "./turn-changes.js";

test("turn snapshots compare full worktrees while leaving the real index alone", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "paseo-turn-changes-test-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    await writeFile(join(cwd, ".gitignore"), "ignored.txt\n");
    await writeFile(join(cwd, "modified.txt"), "committed\n");
    await writeFile(join(cwd, "deleted.txt"), "delete me\n");
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-m", "base");
    await writeFile(join(cwd, "modified.txt"), "before\n");
    git("add", "modified.txt");
    const originalIndex = await readFile(join(cwd, ".git", "index"));
    const before = await captureTurnWorktree(cwd);
    expect(before).toMatch(/^[0-9a-f]{40,64}$/);
    await retainPendingTurnStart(cwd, "agent-1", before!);

    await writeFile(join(cwd, "modified.txt"), "after\n");
    await writeFile(join(cwd, "new.txt"), "new file\n");
    await writeFile(join(cwd, "ignored.txt"), "ignored\n");
    await rm(join(cwd, "deleted.txt"));
    const after = await captureTurnWorktree(cwd);
    expect(after).toMatch(/^[0-9a-f]{40,64}$/);
    await retainTurnChanges(cwd, "agent-1", { turnId: "turn-1", before: before!, after: after! });

    const comparison = await listComparison({
      cwd,
      base: { kind: "rev", rev: before! },
      head: { kind: "rev", rev: after! },
    });
    expect(comparison.files.map((file) => [file.entry.path, file.entry.change])).toEqual([
      ["deleted.txt", "deleted"],
      ["modified.txt", "modified"],
      ["new.txt", "added"],
    ]);
    await comparison.close();
    expect(await readFile(join(cwd, ".git", "index"))).toEqual(originalIndex);
    expect(git("diff", "--cached", "--name-only")).toBe("modified.txt");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
