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
        oldPath: "old.txt",
        status: "ok",
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

test("streamed Changes preserves BOM-prefixed paths and highlighted content", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "stream-bom-diff-"));
  const daemon = await createTestPaseoDaemon({ agentClients: {} });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    execFileSync("git", ["init", "-b", "main"], { cwd });
    writeFileSync(join(cwd, "\uFEFFbom.ts"), "\uFEFFexport const value = 1;\n");
    writeFileSync(join(cwd, "other.txt"), "other edit\n");
    await client.connect();
    const states: import("@getpaseo/client").DiffState[] = [];
    const observation = client.observeDiff({
      cwd,
      base: { kind: "empty" },
      head: { kind: "worktree" },
    });
    const unsubscribe = observation.subscribe({
      snapshot: (state) => states.push(state),
      update: () => {},
    });
    try {
      await expect.poll(() => states.at(-1)?.phase, { timeout: 15000 }).toBe("ready");
      const readyState = states.at(-1);
      if (readyState?.phase !== "ready") throw new Error("Expected ready diff");
      expect(readyState.files.map((file) => file.path)).toContain("other.txt");
      const bomFile = readyState.files.find((file) => file.path === "\uFEFFbom.ts");
      const addedLine = bomFile?.hunks
        .flatMap((hunk) => hunk.lines)
        .find((line) => line.type === "add");
      expect(addedLine?.content).toBe("\uFEFFexport const value = 1;");
      expect(addedLine?.tokens?.map((token) => token.text).join("")).toBe(addedLine?.content);
      expect(states.some((state) => state.phase === "error")).toBe(false);
    } finally {
      unsubscribe();
      await observation.release();
    }
  } finally {
    await client.close();
    await daemon.close();
    rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("checkout refresh from a subdirectory updates a pinned streamed comparison", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "stream-subdirectory-refresh-"));
  const { mkdirSync } = await import("node:fs");
  const workspace = join(cwd, "workspace");
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const daemon = await createTestPaseoDaemon({ agentClients: {} });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    mkdirSync(workspace);
    writeFileSync(join(cwd, "file.txt"), "committed content\n");
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-m", "base");
    const head = git("rev-parse", "HEAD");
    await client.connect();
    const states: import("@getpaseo/client").DiffState[] = [];
    const observation = client.observeDiff({
      cwd: workspace,
      base: { kind: "empty" },
      head: { kind: "rev", rev: head },
    });
    const unsubscribe = observation.subscribe({
      snapshot: (state) => states.push(state),
      update: () => {},
    });
    try {
      await expect.poll(() => states.at(-1)?.phase, { timeout: 15000 }).toBe("ready");
      const initial = states.at(-1);
      if (initial?.phase !== "ready") throw new Error("Expected initial diff");
      expect(initial.files[0]).toMatchObject({ path: "file.txt", status: "ok" });
      expect(await client.checkoutRefresh(workspace)).toMatchObject({ success: true, error: null });
      await expect
        .poll(() => states.at(-1)?.revision, { timeout: 15000 })
        .toBeGreaterThan(initial.revision);
      expect(states.at(-1)).toMatchObject({
        phase: "ready",
        files: [{ path: "file.txt", status: "ok" }],
      });
      writeFileSync(join(cwd, ".git", "info", "attributes"), "file.txt -diff\n");
      await expect
        .poll(() => states.at(-1), { timeout: 15000 })
        .toMatchObject({
          phase: "ready",
          files: [{ path: "file.txt", status: "binary", hunks: [] }],
        });
    } finally {
      unsubscribe();
      await observation.release();
    }
  } finally {
    await client.close();
    await daemon.close();
    rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("refreshing a non-Git workspace succeeds while a Git comparison is open", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "stream-refresh-git-"));
  const plain = mkdtempSync(join(tmpdir(), "stream-refresh-plain-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const daemon = await createTestPaseoDaemon({ agentClients: {} });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    writeFileSync(join(cwd, "file.txt"), "committed content\n");
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-m", "base");
    await client.connect();
    const states: import("@getpaseo/client").DiffState[] = [];
    const observation = client.observeDiff({
      cwd,
      base: { kind: "empty" },
      head: { kind: "rev", rev: git("rev-parse", "HEAD") },
    });
    const unsubscribe = observation.subscribe({
      snapshot: (state) => states.push(state),
      update: () => {},
    });
    try {
      await expect.poll(() => states.at(-1)?.phase, { timeout: 15000 }).toBe("ready");
      const revision = states.at(-1)?.revision;
      expect(await client.checkoutRefresh(plain)).toMatchObject({ success: true, error: null });
      expect(states.at(-1)).toMatchObject({ phase: "ready", revision });
    } finally {
      unsubscribe();
      await observation.release();
    }
  } finally {
    await client.close();
    await daemon.close();
    rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    rmSync(plain, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
