import { test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestPaseoDaemon, DaemonClient } from "./test-utils/index.js";

test("a rename-only commit returns zero added or deleted lines through the client", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "commit-rename-diff-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const daemon = await createTestPaseoDaemon({ agentClients: {} });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    writeFileSync(join(cwd, "old.txt"), "same\n");
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-m", "initial");
    git("mv", "old.txt", "new.txt");
    git("-c", "commit.gpgsign=false", "commit", "-m", "rename");
    const sha = git("rev-parse", "HEAD");

    await client.connect();
    const history = await client.listCheckoutCommits(cwd);
    expect(history.commits.find((commit) => commit.sha === sha)?.files).toEqual([
      { path: "new.txt", additions: 0, deletions: 0, status: "renamed" },
    ]);
    expect(await client.getCommitFileDiff(cwd, sha, "new.txt")).toEqual({
      file: {
        path: "new.txt",
        isNew: false,
        isDeleted: false,
        additions: 0,
        deletions: 0,
        hunks: [],
      },
    });
  } finally {
    await client.close();
    await daemon.close();
    rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test.skipIf(process.platform === "win32")(
  "checkout and commit diffs preserve filenames that Git quotes",
  async () => {
    const cwd = mkdtempSync(join(tmpdir(), "git-filename-diffs-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    const names = [
      'report "draft".txt',
      "back\\slash.txt",
      "tab\tname.txt",
      "normal.txt",
      "with spaces.txt",
    ];
    const editLines = expect.arrayContaining([
      expect.objectContaining({ type: "remove", content: "before" }),
      expect.objectContaining({ type: "add", content: "after" }),
    ]);
    const daemon = await createTestPaseoDaemon({ agentClients: {} });
    const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
    try {
      git("init", "-b", "main");
      git("config", "user.name", "Test");
      git("config", "user.email", "test@example.com");
      git("config", "core.quotepath", "false");
      for (const name of names) writeFileSync(join(cwd, name), "before\n");
      git("add", ".");
      git("-c", "commit.gpgsign=false", "commit", "-m", "initial");
      for (const name of names) writeFileSync(join(cwd, name), "after\n");

      await client.connect();
      const checkout = await client.getCheckoutDiff(cwd, { mode: "uncommitted" });
      expect(checkout.error).toBeNull();
      expect(checkout.files.map((file) => file.path).sort()).toEqual([...names].sort());
      for (const file of checkout.files) {
        expect(file).toMatchObject({ status: "ok", additions: 1, deletions: 1 });
        expect(file.hunks.flatMap((hunk) => hunk.lines)).toEqual(editLines);
      }

      git("add", ".");
      git("-c", "commit.gpgsign=false", "commit", "-m", "edit");
      const sha = git("rev-parse", "HEAD");
      for (const name of names) {
        const commit = await client.getCommitFileDiff(cwd, sha, name);
        expect(commit.file).toMatchObject({ path: name, additions: 1, deletions: 1 });
        expect(commit.file?.hunks.flatMap((hunk) => hunk.lines)).toEqual(editLines);
        const file = await client.readFile(cwd, name);
        expect(file.kind).toBe("text");
        expect(new TextDecoder().decode(file.bytes)).toBe("after\n");
      }
    } finally {
      await client.close();
      await daemon.close();
      rmSync(cwd, { recursive: true, force: true });
    }
  },
);
