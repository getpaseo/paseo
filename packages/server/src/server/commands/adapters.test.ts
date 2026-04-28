import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { CommandAdapter, COMMAND_TARGETS } from "./adapters.js";
import type { HubcodeCommand } from "./types.js";

/**
 * These tests exercise the on-disk behaviour of the adapter against the
 * real filesystem. Each test isolates per-target roots inside a tmp dir so
 * we never touch the real `~/.claude/`, `~/.codex/`, etc.
 */
describe("CommandAdapter", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "hubcode-cmd-adapter-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Overrides the global dirs inside COMMAND_TARGETS for the duration of a test. */
  const withRedirectedTargets = async <T>(fn: () => Promise<T>): Promise<T> => {
    const original = COMMAND_TARGETS.map((t) => ({ ...t }));
    for (const target of COMMAND_TARGETS) {
      if (target.globalDir) {
        target.globalDir = path.join(root, "home", target.id, "commands");
      }
    }
    try {
      return await fn();
    } finally {
      for (let i = 0; i < COMMAND_TARGETS.length; i++) {
        COMMAND_TARGETS[i]!.globalDir = original[i]!.globalDir;
      }
    }
  };

  const adapter = (activeAgents: string[]) =>
    new CommandAdapter({
      logger: createTestLogger(),
      resolveActiveAgents: async () => new Set(activeAgents),
    });

  const cmd = (overrides: Partial<HubcodeCommand> = {}): HubcodeCommand => ({
    id: "user.plan",
    name: "plan",
    description: "Plan out work",
    prompt: "Plan the implementation step by step.",
    author: "user",
    scope: "global",
    ...overrides,
  });

  it("writes a global command file into an activated CLI dir", async () => {
    await withRedirectedTargets(async () => {
      const target = COMMAND_TARGETS.find((t) => t.id === "claude")!;
      await adapter(["claude"]).syncAll([cmd()]);

      const file = path.join(target.globalDir!, "plan.md");
      const content = await readFile(file, "utf8");
      // Sentinel lives just after frontmatter so host agents parse the
      // description correctly; test allows it anywhere in the first 500 chars.
      expect(content.slice(0, 500)).toContain("<!-- hubcode:command -->");
      expect(content).toMatch(/^---\ndescription:/);
      // name is derived from the filename by Claude Code / Codex, not frontmatter.
      expect(content).toContain('description: "Plan out work"');
      expect(content).toContain("Plan the implementation step by step.");
    });
  });

  it("skips targets that are not activated", async () => {
    await withRedirectedTargets(async () => {
      const target = COMMAND_TARGETS.find((t) => t.id === "codex")!;
      await adapter(["claude"]).syncAll([cmd()]);

      // Codex dir should not even exist.
      await expect(readdir(target.globalDir!)).rejects.toThrow();
    });
  });

  it("honours targetAgents restriction", async () => {
    await withRedirectedTargets(async () => {
      const claudeDir = COMMAND_TARGETS.find((t) => t.id === "claude")!.globalDir!;
      const codexDir = COMMAND_TARGETS.find((t) => t.id === "codex")!.globalDir!;

      await adapter(["claude", "codex"]).syncAll([cmd({ targetAgents: ["claude"] })]);

      expect((await readdir(claudeDir)).length).toBe(1);
      await expect(readdir(codexDir)).rejects.toThrow();
    });
  });

  it("cleans up stale hubcode-authored files on resync", async () => {
    await withRedirectedTargets(async () => {
      const a = adapter(["claude"]);
      await a.syncAll([cmd({ id: "user.a", name: "a" }), cmd({ id: "user.b", name: "b" })]);

      const dir = COMMAND_TARGETS.find((t) => t.id === "claude")!.globalDir!;
      expect(await readdir(dir)).toEqual(expect.arrayContaining(["a.md", "b.md"]));

      // Remove "b" from desired set.
      await a.syncAll([cmd({ id: "user.a", name: "a" })]);
      const after = await readdir(dir);
      expect(after).toEqual(["a.md"]);
    });
  });

  it("preserves user-authored files without the sentinel", async () => {
    await withRedirectedTargets(async () => {
      const dir = COMMAND_TARGETS.find((t) => t.id === "claude")!.globalDir!;
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "mine.md"), "# user wrote this", "utf8");

      await adapter(["claude"]).syncAll([cmd()]);
      // After sync we re-read "mine.md" — it must survive.
      const mine = await readFile(path.join(dir, "mine.md"), "utf8");
      expect(mine).toBe("# user wrote this");
    });
  });

  it("writes project-scope commands into each projectPath", async () => {
    const projectA = path.join(root, "proj-a");
    const projectB = path.join(root, "proj-b");
    await mkdir(projectA, { recursive: true });
    await mkdir(projectB, { recursive: true });

    await adapter(["claude"]).syncAll([
      cmd({ scope: "project", projectPaths: [projectA, projectB] }),
    ]);

    const pa = path.join(projectA, ".claude", "commands", "plan.md");
    const pb = path.join(projectB, ".claude", "commands", "plan.md");
    expect((await readFile(pa, "utf8")).slice(0, 500)).toContain("<!-- hubcode:command -->");
    expect((await readFile(pb, "utf8")).slice(0, 500)).toContain("<!-- hubcode:command -->");
  });

  it("reports install status per agent reflecting activation", async () => {
    await withRedirectedTargets(async () => {
      // Only "claude" is active; codex and opencode are not.
      const statuses = await adapter(["claude"]).statusFor(cmd());
      const byId = new Map(statuses.map((s) => [s.agentId, s]));
      expect(byId.get("claude")?.agentActive).toBe(true);
      expect(byId.get("claude")?.status).toBe("not-installed");
      expect(byId.get("codex")?.agentActive).toBe(false);
      expect(byId.get("codex")?.status).toBe("disabled");
    });
  });
});
