import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { DiffOpcode, type DiffFrame } from "@getpaseo/protocol/binary-frames/index";
import { DiffSubscriptions } from "./index.js";
import { createFileObserver } from "../file-observer/index.js";

test("shares computation, highlights only the changed file, recovers refs and releases observations", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "diff-subscriptions-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const observer = createFileObserver();
  const subscriptions = new DiffSubscriptions({
    async requestWorkingTreeWatch(root, onChange) {
      const subscription = await observer.subscribe(root, () => onChange(), {
        ignore: [join(root, ".git")],
      });
      return {
        repoRoot: root,
        unsubscribe: () => {
          void subscription.unsubscribe();
        },
      };
    },
  });
  const first: DiffFrame[] = [];
  const second: DiffFrame[] = [];
  try {
    git("init", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    await writeFile(join(cwd, "README"), "base\n");
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-m", "base");
    for (let index = 0; index < 252; index++)
      await writeFile(join(cwd, `${index}.ts`), `const value = ${index};\n`);
    const compare = {
      cwd,
      base: { kind: "rev" as const, rev: "HEAD" },
      head: { kind: "worktree" as const },
      highlight: true,
    };
    const coldStarted = performance.now();
    let lastEndAt = coldStarted;
    const a = await subscriptions.subscribe(compare, async (frame) => {
      first.push(frame);
      if (frame.opcode === DiffOpcode.End) lastEndAt = performance.now();
    });
    await a.start();
    const coldMs = lastEndAt - coldStarted;
    const before = subscriptions.getMetrics().computations;
    const previousHighlightCalls = subscriptions.getMetrics().highlightCalls;
    const b = await subscriptions.subscribe(compare, async (frame) => {
      second.push(frame);
    });
    await b.start();
    expect(subscriptions.getMetrics()).toEqual({
      targets: 1,
      subscriptions: 2,
      computations: before,
      highlightCalls: previousHighlightCalls,
      metadataObservers: 1,
    });
    first.length = 0;
    second.length = 0;
    const refreshStarted = performance.now();
    await writeFile(join(cwd, "9.ts"), "const value = 999;\n");
    await expect
      .poll(() => first.filter((frame) => frame.opcode === DiffOpcode.End).length)
      .toBeGreaterThan(0);
    const begin = first.find((frame) => frame.opcode === DiffOpcode.Begin);
    if (!begin || begin.opcode !== DiffOpcode.Begin) throw new Error("Missing begin");
    expect(begin.entries.filter((entry) => entry.body).map((entry) => entry.path)).toEqual([
      "9.ts",
    ]);
    const bodies = first.filter((frame) => frame.opcode === DiffOpcode.Bodies);
    expect(bodies).toHaveLength(1);
    expect(second).toEqual(first);
    await expect
      .poll(() => subscriptions.getMetrics().highlightCalls, { timeout: 10000 })
      .toBe(previousHighlightCalls + 1);
    const artifactDirectory = join(
      import.meta.dirname,
      "../../../../../.artifacts/diff-subscription",
    );
    await mkdir(artifactDirectory, { recursive: true });
    await writeFile(
      join(artifactDirectory, "refresh-metrics.json"),
      JSON.stringify(
        {
          files: 252,
          coldMs,
          oneFileRefreshMs: lastEndAt - refreshStarted,
          changedBodies: bodies.length,
          highlightCalls: subscriptions.getMetrics().highlightCalls - previousHighlightCalls,
        },
        null,
        2,
      ),
    );
    await a.release();
    await b.release();
    expect(subscriptions.getMetrics().targets).toBe(0);
    expect(subscriptions.getMetrics().metadataObservers).toBe(0);
    const missing: DiffFrame[] = [];
    const recovery = await subscriptions.subscribe(
      {
        ...compare,
        base: { kind: "rev", rev: "refs/tags/later" },
        head: { kind: "rev", rev: "HEAD" },
      },
      async (frame) => {
        missing.push(frame);
      },
    );
    await recovery.start();
    expect(missing.at(-1)).toMatchObject({
      opcode: DiffOpcode.End,
      error: { code: "REF_NOT_FOUND" },
    });
    missing.length = 0;
    git("update-ref", "refs/tags/later", "HEAD");
    await expect
      .poll(
        () => missing.some((frame) => frame.opcode === DiffOpcode.End && frame.error === null),
        { timeout: 10_000 },
      )
      .toBe(true);
    await recovery.release();
  } finally {
    await subscriptions.close();
    await observer.close();
    await rm(cwd, { recursive: true, force: true });
  }
}, 30_000);

test("supersedes an in-flight revision at a batch boundary and ends the replacement", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "diff-supersede-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const observer = createFileObserver();
  const subscriptions = new DiffSubscriptions({
    async requestWorkingTreeWatch(root, onChange) {
      const watch = await observer.subscribe(root, () => onChange(), {
        ignore: [join(root, ".git")],
      });
      return {
        repoRoot: root,
        unsubscribe: async () => {
          await watch.unsubscribe();
        },
      };
    },
  });
  const frames: DiffFrame[] = [];
  let interrupted = false;
  try {
    git("init", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    await writeFile(join(cwd, "README"), "base\n");
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-m", "base");
    const content =
      Array.from(
        { length: 100 },
        (_, index) => `export const fn${index} = (value: string) => ({ value, count: ${index} });`,
      ).join("\n") + "\n";
    for (let index = 0; index < 80; index++) await writeFile(join(cwd, `${index}.ts`), content);
    const subscription = await subscriptions.subscribe(
      { cwd, base: { kind: "rev", rev: "HEAD" }, head: { kind: "worktree" } },
      async (frame) => {
        frames.push(frame);
        if (frame.opcode === DiffOpcode.Bodies && !interrupted) {
          interrupted = true;
          await writeFile(join(cwd, "0.ts"), content + "export const added = true;\n");
          subscriptions.invalidateForCwd(cwd);
        }
      },
    );
    await subscription.start();
    const begins = frames.filter((frame) => frame.opcode === DiffOpcode.Begin);
    expect(interrupted).toBe(true);
    expect(begins.length).toBeGreaterThan(1);
    for (let index = 0; index < begins.length - 1; index++) {
      const revision = begins[index].revision;
      const ended = frames.some(
        (frame) => frame.opcode === DiffOpcode.End && frame.revision === revision,
      );
      const superseded = begins[index + 1].revision > revision;
      expect(ended || superseded).toBe(true);
    }
    expect(frames.at(-1)).toMatchObject({
      opcode: DiffOpcode.End,
      revision: begins.at(-1)?.revision,
      error: null,
    });
    await subscription.release();
  } finally {
    await subscriptions.close();
    await observer.close();
    await rm(cwd, { recursive: true, force: true });
  }
}, 30_000);

test("moving, deleting and recreating a branch recovers, and staging changes the resolved index SHA", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "diff-ref-index-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const observer = createFileObserver();
  const subscriptions = new DiffSubscriptions({
    async requestWorkingTreeWatch(root, changed) {
      const watch = await observer.subscribe(root, () => changed(), {
        ignore: [join(root, ".git")],
      });
      return {
        repoRoot: root,
        unsubscribe: async () => {
          await watch.unsubscribe();
        },
      };
    },
  });
  const frames: DiffFrame[] = [];
  try {
    git("init", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    await writeFile(join(cwd, "README"), "base\n");
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-m", "base");
    git("branch", "compare");
    await writeFile(join(cwd, "x.ts"), "export const value = 1;\n");
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-m", "feature");
    const head = git("rev-parse", "HEAD");
    const branch = await subscriptions.subscribe(
      { cwd, base: { kind: "rev", rev: "refs/heads/compare" }, head: { kind: "rev", rev: "HEAD" } },
      async (frame) => {
        frames.push(frame);
      },
    );
    await branch.start();
    frames.length = 0;
    git("update-ref", "refs/heads/compare", head);
    await expect
      .poll(() => frames.some((frame) => frame.opcode === DiffOpcode.End), { timeout: 10000 })
      .toBe(true);
    expect(frames.find((frame) => frame.opcode === DiffOpcode.Begin)).toMatchObject({
      baseSha: head,
      entries: [],
    });
    frames.length = 0;
    git("update-ref", "-d", "refs/heads/compare");
    await expect
      .poll(
        () =>
          frames.some(
            (frame) => frame.opcode === DiffOpcode.End && frame.error?.code === "REF_NOT_FOUND",
          ),
        { timeout: 10000 },
      )
      .toBe(true);
    frames.length = 0;
    git("update-ref", "refs/heads/compare", head);
    await expect
      .poll(() => frames.some((frame) => frame.opcode === DiffOpcode.End && frame.error === null), {
        timeout: 10000,
      })
      .toBe(true);
    await branch.release();
    frames.length = 0;
    const staged = await subscriptions.subscribe(
      { cwd, base: { kind: "rev", rev: "HEAD" }, head: { kind: "index" } },
      async (frame) => {
        frames.push(frame);
      },
    );
    await staged.start();
    const old = frames.find((frame) => frame.opcode === DiffOpcode.Begin);
    if (!old || old.opcode !== DiffOpcode.Begin) throw new Error("Missing initial index revision");
    frames.length = 0;
    await writeFile(join(cwd, "staged.ts"), "export const staged = true;\n");
    git("add", "staged.ts");
    await expect
      .poll(() => frames.some((frame) => frame.opcode === DiffOpcode.End), { timeout: 10000 })
      .toBe(true);
    const changed = frames.find((frame) => frame.opcode === DiffOpcode.Begin);
    if (!changed || changed.opcode !== DiffOpcode.Begin) throw new Error("Missing staged revision");
    expect(changed.headSha).not.toBe(old.headSha);
    expect(changed.entries.map((entry) => entry.path)).toEqual(["staged.ts"]);
    await staged.release();
  } finally {
    await subscriptions.close();
    await observer.close();
    await rm(cwd, { recursive: true, force: true });
  }
}, 30000);

test("a cached replay completes before a live refresh can depend on it", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "diff-replay-order-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
  const subscriptions = new DiffSubscriptions({
    async requestWorkingTreeWatch() {
      return { repoRoot: cwd, unsubscribe: async () => {} };
    },
  });
  let resume!: () => void;
  let began!: () => void;
  const paused = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const replayBegan = new Promise<void>((resolve) => {
    began = resolve;
  });
  const frames: DiffFrame[] = [];
  try {
    git("init", "-b", "main");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test");
    await writeFile(join(cwd, "a.txt"), "base\n");
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-m", "base");
    await writeFile(join(cwd, "a.txt"), "first\n");
    const compare = {
      cwd,
      base: { kind: "rev", rev: "HEAD" },
      head: { kind: "worktree" },
      highlight: false,
    } as const;
    const first = await subscriptions.subscribe(compare, async () => {});
    await first.start();
    const second = await subscriptions.subscribe(compare, async (frame) => {
      frames.push(frame);
      if (frames.length === 1) {
        began();
        await paused;
      }
    });
    const replay = second.start();
    await replayBegan;
    await writeFile(join(cwd, "a.txt"), "second\n");
    subscriptions.invalidateForCwd(cwd);
    await new Promise((resolve) => setTimeout(resolve, 250));
    resume();
    await replay;
    await expect
      .poll(() => frames.filter((frame) => frame.opcode === DiffOpcode.End).length)
      .toBe(2);
    let committed = 0;
    for (const frame of frames) {
      if (frame.opcode === DiffOpcode.Begin) expect([0, committed]).toContain(frame.baseRevision);
      if (frame.opcode === DiffOpcode.End) committed = frame.revision;
    }
    await second.release();
    await first.release();
  } finally {
    resume();
    await subscriptions.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("submodule commits invalidate cached worktree gitlink bodies", async () => {
  const { lstat } = await import("node:fs/promises");
  const cwd = await mkdtemp(join(tmpdir(), "diff-gitlink-cache-"));
  const sub = join(cwd, "sub");
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const streams = new DiffSubscriptions({
    async requestWorkingTreeWatch(root) {
      return { repoRoot: root, unsubscribe: async () => {} };
    },
  });
  const frames: DiffFrame[] = [];
  try {
    git("init", "-b", "main");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@example.com");
    await mkdir(sub);
    git("-C", "sub", "init", "-b", "main");
    git("-C", "sub", "config", "user.name", "Test");
    git("-C", "sub", "config", "user.email", "test@example.com");
    await writeFile(join(sub, "a.txt"), "A\n");
    git("-C", "sub", "add", ".");
    git("-C", "sub", "-c", "commit.gpgsign=false", "commit", "-m", "A");
    git("add", ".");
    git("-c", "commit.gpgsign=false", "commit", "-m", "record A");
    await writeFile(join(sub, "a.txt"), "B\n");
    git("-C", "sub", "-c", "commit.gpgsign=false", "commit", "-am", "B");
    const before = await lstat(sub, { bigint: true });
    const subscription = await streams.subscribe(
      { cwd, base: { kind: "rev", rev: "HEAD" }, head: { kind: "worktree" } },
      async (frame) => {
        frames.push(frame);
      },
    );
    await subscription.start();
    expect(frames.at(-1)).toMatchObject({ opcode: DiffOpcode.End, error: null });
    frames.length = 0;
    await writeFile(join(sub, "a.txt"), "C\n");
    git("-C", "sub", "-c", "commit.gpgsign=false", "commit", "-am", "C");
    const sha = git("-C", "sub", "rev-parse", "HEAD");
    expect((await lstat(sub, { bigint: true })).mtimeNs).toBe(before.mtimeNs);
    streams.invalidateForCwd(cwd);
    await expect
      .poll(() => frames.some((frame) => frame.opcode === DiffOpcode.End), { timeout: 5000 })
      .toBe(true);
    const bodies = frames.flatMap((frame) =>
      frame.opcode === DiffOpcode.Bodies ? frame.files : [],
    );
    expect(bodies.flatMap((file) => file.hunks.flatMap((hunk) => hunk.lines))).toContainEqual(
      expect.objectContaining({ type: "add", content: `Subproject commit ${sha}` }),
    );
    await subscription.release();
  } finally {
    await streams.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

test.each([true, false])(
  "tracked=%s timestamp-preserving replacements refresh cached bodies",
  async (tracked) => {
    const { lstat, utimes } = await import("node:fs/promises");
    const cwd = await mkdtemp(join(tmpdir(), "diff-preserved-time-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    const streams = new DiffSubscriptions({
      async requestWorkingTreeWatch(root) {
        return { repoRoot: root, unsubscribe: async () => {} };
      },
    });
    const frames: DiffFrame[] = [];
    const path = join(cwd, "file.txt");
    const timestamp = new Date("2000-01-01T00:00:00Z");
    try {
      git("init", "-b", "main");
      git("config", "user.name", "Test");
      git("config", "user.email", "test@example.com");
      await writeFile(join(cwd, "README"), "base\n");
      if (tracked) await writeFile(path, "base\n");
      git("add", ".");
      git("-c", "commit.gpgsign=false", "commit", "-m", "base");
      await writeFile(path, "first\n");
      await utimes(path, timestamp, timestamp);
      const compare = {
        cwd,
        base: { kind: "rev" as const, rev: "HEAD" },
        head: { kind: "worktree" as const },
      };
      const subscription = await streams.subscribe(compare, async (frame) => {
        frames.push(frame);
      });
      await subscription.start();
      expect(frames.at(-1)).toMatchObject({ opcode: DiffOpcode.End, error: null });
      const before = await lstat(path, { bigint: true });
      frames.length = 0;
      await writeFile(path, "later\n");
      await utimes(path, timestamp, timestamp);
      const after = await lstat(path, { bigint: true });
      expect(after.mtimeNs).toBe(before.mtimeNs);
      expect(after.size).toBe(before.size);
      expect(after.ctimeNs).not.toBe(before.ctimeNs);
      streams.invalidateForCwd(cwd);
      await expect
        .poll(() => frames.some((frame) => frame.opcode === DiffOpcode.End), { timeout: 5000 })
        .toBe(true);
      const files = frames.flatMap((frame) =>
        frame.opcode === DiffOpcode.Bodies ? frame.files : [],
      );
      expect(files.flatMap((file) => file.hunks.flatMap((hunk) => hunk.lines))).toContainEqual(
        expect.objectContaining({ type: "add", content: "later" }),
      );
      const { listComparison } = await import("./git.js");
      const fresh = await listComparison(compare);
      try {
        const record = await fresh.read(fresh.files[0]);
        if (record.kind !== "ready") throw new Error("Expected readable replacement");
        expect(files).toEqual([record.body]);
      } finally {
        await fresh.close();
      }
      await subscription.release();
    } finally {
      await streams.close();
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

test.each([true, false])(
  "autocrlf=%s highlighted CRLF worktrees keep the revision readable",
  async (autocrlf) => {
    const cwd = await mkdtemp(join(tmpdir(), "diff-crlf-"));
    const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    const streams = new DiffSubscriptions({
      async requestWorkingTreeWatch(root) {
        return { repoRoot: root, unsubscribe: async () => {} };
      },
    });
    const frames: DiffFrame[] = [];
    try {
      git("init", "-b", "main");
      git("config", "user.name", "Test");
      git("config", "user.email", "test@example.com");
      git("config", "core.autocrlf", String(autocrlf));
      await writeFile(join(cwd, "a.ts"), "export const value = 1;\r\n");
      await writeFile(join(cwd, "b.txt"), "before\n");
      git("add", ".");
      git("-c", "commit.gpgsign=false", "commit", "-m", "base");
      await writeFile(join(cwd, "a.ts"), "export const value = 2;\r\n");
      await writeFile(join(cwd, "b.txt"), "after\n");
      const subscription = await streams.subscribe(
        { cwd, base: { kind: "rev", rev: "HEAD" }, head: { kind: "worktree" } },
        async (frame) => {
          frames.push(frame);
        },
      );
      await subscription.start();
      expect(frames.at(-1)).toMatchObject({ opcode: DiffOpcode.End, error: null });
      const files = frames.flatMap((frame) =>
        frame.opcode === DiffOpcode.Bodies ? frame.files : [],
      );
      expect(files.map((file) => file.path)).toEqual(["a.ts", "b.txt"]);
      const line = files[0].hunks
        .flatMap((hunk) => hunk.lines)
        .find((candidate) => candidate.type === "add");
      expect(line?.content).toBe(`export const value = 2;${autocrlf ? "" : "\r"}`);
      expect(line?.runs?.reduce((length, run) => length + run.length, 0)).toBe(
        line?.content.length,
      );
      await subscription.release();
    } finally {
      await streams.close();
      await rm(cwd, { recursive: true, force: true });
    }
  },
);
