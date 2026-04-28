import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { RuleAdapter, RULE_TARGETS } from "./adapters.js";
import type { HubcodeRule } from "./types.js";

describe("RuleAdapter — managed section", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "hubcode-rules-adapter-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Redirect globalFile of each target to a path under `root/<id>/…`. */
  const withRedirectedTargets = async <T>(fn: () => Promise<T>): Promise<T> => {
    const original = RULE_TARGETS.map((t) => ({ ...t }));
    for (const t of RULE_TARGETS) {
      if (t.globalFile) t.globalFile = path.join(root, "home", t.id, path.basename(t.globalFile));
    }
    try {
      return await fn();
    } finally {
      for (let i = 0; i < RULE_TARGETS.length; i++) {
        RULE_TARGETS[i]!.globalFile = original[i]!.globalFile;
      }
    }
  };

  const adapter = (active: string[]) =>
    new RuleAdapter({
      logger: createTestLogger(),
      resolveActiveAgents: async () => new Set(active),
    });

  const rule = (overrides: Partial<HubcodeRule> = {}): HubcodeRule => ({
    id: "user.r1",
    title: "Always typecheck",
    body: "Run typecheck after every code change.",
    author: "user",
    scope: "global",
    ...overrides,
  });

  it("writes a managed section into the target global file", async () => {
    await withRedirectedTargets(async () => {
      await adapter(["claude"]).syncAll([rule()]);
      const file = RULE_TARGETS.find((t) => t.id === "claude")!.globalFile!;
      const body = await readFile(file, "utf8");
      expect(body).toContain("<!-- hubcode:rules start -->");
      expect(body).toContain("<!-- hubcode:rules end -->");
      expect(body).toContain("Always typecheck");
      expect(body).toContain("<!-- hubcode:rule user.r1 -->");
    });
  });

  it("preserves user content outside the markers", async () => {
    await withRedirectedTargets(async () => {
      const file = RULE_TARGETS.find((t) => t.id === "claude")!.globalFile!;
      await mkdir(path.dirname(file), { recursive: true });
      const userContent = "# My personal notes\n\nSome stuff the user wrote.\n";
      await writeFile(file, userContent, "utf8");

      await adapter(["claude"]).syncAll([rule()]);
      const body = await readFile(file, "utf8");
      expect(body).toContain("# My personal notes");
      expect(body).toContain("Some stuff the user wrote.");
      expect(body).toContain("Always typecheck");
    });
  });

  it("replaces a prior managed section instead of duplicating it", async () => {
    await withRedirectedTargets(async () => {
      const a = adapter(["claude"]);
      await a.syncAll([rule({ id: "user.r1", title: "V1", body: "v1" })]);
      await a.syncAll([rule({ id: "user.r1", title: "V2", body: "v2" })]);
      const file = RULE_TARGETS.find((t) => t.id === "claude")!.globalFile!;
      const body = await readFile(file, "utf8");
      // Only one BEGIN marker.
      const beginCount = body.split("<!-- hubcode:rules start -->").length - 1;
      expect(beginCount).toBe(1);
      expect(body).toContain("V2");
      expect(body).not.toContain("V1");
    });
  });

  it("removes the managed section when no rules are enabled, preserving user content", async () => {
    await withRedirectedTargets(async () => {
      const a = adapter(["claude"]);
      const file = RULE_TARGETS.find((t) => t.id === "claude")!.globalFile!;
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "# user\n", "utf8");
      await a.syncAll([rule()]);
      await a.syncAll([]);
      const body = await readFile(file, "utf8");
      expect(body).toContain("# user");
      expect(body).not.toContain("<!-- hubcode:rules start -->");
    });
  });

  it("writes project-scope rules into AGENTS.md under each projectPath", async () => {
    const projectA = path.join(root, "proj-a");
    await mkdir(projectA, { recursive: true });
    await adapter(["codex"]).syncAll([rule({ scope: "project", projectPaths: [projectA] })]);
    const body = await readFile(path.join(projectA, "AGENTS.md"), "utf8");
    expect(body).toContain("<!-- hubcode:rule user.r1 -->");
  });

  it("deduplicates when two targets share the same project file (AGENTS.md)", async () => {
    const projectA = path.join(root, "proj-a");
    await mkdir(projectA, { recursive: true });
    await adapter(["codex", "opencode"]).syncAll([
      rule({ scope: "project", projectPaths: [projectA] }),
    ]);
    // Both codex and opencode use AGENTS.md — we should have exactly one.
    const body = await readFile(path.join(projectA, "AGENTS.md"), "utf8");
    const beginCount = body.split("<!-- hubcode:rules start -->").length - 1;
    expect(beginCount).toBe(1);
    // Only one occurrence of the rule marker.
    const ruleCount = body.split("<!-- hubcode:rule user.r1 -->").length - 1;
    expect(ruleCount).toBe(1);
  });

  it("reports per-agent install status reflecting activation", async () => {
    await withRedirectedTargets(async () => {
      const statuses = await adapter(["claude"]).statusFor(rule());
      const byId = new Map(statuses.map((s) => [s.agentId, s]));
      expect(byId.get("claude")?.status).toBe("not-installed");
      expect(byId.get("codex")?.agentActive).toBe(false);
      expect(byId.get("codex")?.status).toBe("disabled");
      expect(byId.get("cursor")?.status).toBe("unsupported");
    });
  });
});
