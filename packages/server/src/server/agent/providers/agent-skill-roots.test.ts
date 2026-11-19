import { describe, expect, test } from "vitest";

import { resolveAgentSkillRoots } from "./agent-skill-roots.js";

describe("resolveAgentSkillRoots", () => {
  test("scans the workspace before the user's homes", () => {
    const roots = resolveAgentSkillRoots({ cwd: "/work/repo", home: "/home/user" });
    expect(roots.slice(0, 2)).toEqual(["/work/repo/.agents/skills", "/work/repo/.claude/skills"]);
    expect(roots.filter((root) => root.startsWith("/home/user"))).toEqual([
      "/home/user/.agents/skills",
      "/home/user/.claude/skills",
      "/home/user/.codex/skills",
      "/home/user/.zcode/skills",
    ]);
  });

  test("the shared .agents home wins over an agent-specific home", () => {
    const roots = resolveAgentSkillRoots({ cwd: "/work/repo", home: "/home/user" });
    const agents = roots.findIndex((root) => root === "/home/user/.agents/skills");
    const codex = roots.findIndex((root) => root === "/home/user/.codex/skills");
    expect(agents).toBeGreaterThanOrEqual(0);
    expect(codex).toBeGreaterThan(agents);
  });
});
