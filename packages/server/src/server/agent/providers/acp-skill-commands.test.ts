import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  discoverACPSkills,
  parseACPSkillInvocation,
  renderACPSkillInvocation,
  toSlashCommand,
  type DiscoveredACPSkill,
} from "./acp-skill-commands.js";

describe("discoverACPSkills", () => {
  function skillNames(skills: DiscoveredACPSkill[]): string[] {
    return skills.map((s) => s.name);
  }

  test("follows symlinked skill directories", async () => {
    await withSandbox(async (root) => {
      const realSkill = path.join(root, "real-skill");
      await mkdir(realSkill, { recursive: true });
      await writeFile(
        path.join(realSkill, "SKILL.md"),
        "---\ndescription: A real skill\n---\nbody\n",
      );

      const linkedSkill = path.join(root, "linked-skill");
      await mkdir(linkedSkill, { recursive: true });
      await writeFile(
        path.join(linkedSkill, "SKILL.md"),
        "---\ndescription: A linked skill\n---\nbody\n",
      );

      const claudeDir = path.join(root, ".claude", "skills");
      await mkdir(claudeDir, { recursive: true });
      await symlink(realSkill, path.join(claudeDir, "real-skill"), "dir");
      await symlink(linkedSkill, path.join(claudeDir, "linked-skill"), "dir");

      const skills = await discoverACPSkills({ roots: [claudeDir] });
      expect(skillNames(skills).sort()).toEqual(["linked-skill", "real-skill"]);
    });
  });

  test("respects root precedence: earlier root wins", async () => {
    await withSandbox(async (root) => {
      // Two roots that both contain a "shared" skill; the earlier root must win.
      const rootA = path.join(root, "rootA");
      const rootB = path.join(root, "rootB");
      await mkdir(path.join(rootA, "shared"), { recursive: true });
      await mkdir(path.join(rootB, "shared"), { recursive: true });
      await writeFile(
        path.join(rootA, "shared", "SKILL.md"),
        "---\ndescription: A wins\n---\nbody\n",
      );
      await writeFile(
        path.join(rootB, "shared", "SKILL.md"),
        "---\ndescription: B loses\n---\nbody\n",
      );

      const merged = await discoverACPSkills({ roots: [rootA, rootB] });
      expect(skillNames(merged)).toEqual(["shared"]);
      expect(merged[0]!.description).toBe("A wins");
    });
  });

  test("skips directories without SKILL.md", async () => {
    await withSandbox(async (root) => {
      const empty = path.join(root, "empty");
      await mkdir(empty, { recursive: true });

      const skills = await discoverACPSkills({ roots: [root] });
      expect(skills).toEqual([]);
    });
  });

  test("swallows unreadable roots", async () => {
    const skills = await discoverACPSkills({ roots: ["/nonexistent/path/that/does/not/exist"] });
    expect(skills).toEqual([]);
  });

  test("parses frontmatter description and argument-hint", async () => {
    await withSandbox(async (root) => {
      const skillDir = path.join(root, "my-skill");
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        path.join(skillDir, "SKILL.md"),
        [
          "---",
          "name: my-skill",
          "description: Do something useful",
          "argument-hint: <file> [options]",
          "---",
          "",
          "Body here",
        ].join("\n"),
      );

      const skills = await discoverACPSkills({ roots: [root] });
      expect(skills).toHaveLength(1);
      expect(skills[0]!.name).toBe("my-skill");
      expect(skills[0]!.description).toBe("Do something useful");
      expect(skills[0]!.argumentHint).toBe("<file> [options]");
    });
  });

  test("falls back to first heading when no description in frontmatter", async () => {
    await withSandbox(async (root) => {
      const skillDir = path.join(root, "no-desc");
      await mkdir(skillDir, { recursive: true });
      await writeFile(path.join(skillDir, "SKILL.md"), "# My Heading\n\nBody\n");

      const skills = await discoverACPSkills({ roots: [root] });
      expect(skills[0]!.description).toBe("My Heading");
    });
  });
});

describe("parseACPSkillInvocation", () => {
  test("matches a leading /name", () => {
    const skill = makeSkill("my-skill");
    const result = parseACPSkillInvocation("/my-skill", [skill]);
    expect(result?.skill.name).toBe("my-skill");
    expect(result?.args).toBe("");
  });

  test("captures arguments", () => {
    const skill = makeSkill("my-skill");
    const result = parseACPSkillInvocation("/my-skill do the thing", [skill]);
    expect(result?.args).toBe("do the thing");
  });

  test("returns undefined for unknown names", () => {
    const result = parseACPSkillInvocation("/unknown", [makeSkill("my-skill")]);
    expect(result).toBeUndefined();
  });

  test("returns undefined for non-slash text", () => {
    const result = parseACPSkillInvocation("hello world", [makeSkill("my-skill")]);
    expect(result).toBeUndefined();
  });
});

describe("renderACPSkillInvocation", () => {
  test("renders skill body with source", () => {
    const skill = makeSkill("my-skill", { body: "Do the thing", source: "/path/SKILL.md" });
    const rendered = renderACPSkillInvocation({ skill, args: "" });
    expect(rendered).toContain('<skill name="my-skill" source="/path/SKILL.md">');
    expect(rendered).toContain("Do the thing");
  });

  test("substitutes $ARGUMENTS", () => {
    const skill = makeSkill("my-skill", { body: "Process $ARGUMENTS carefully" });
    const rendered = renderACPSkillInvocation({ skill, args: "the files" });
    expect(rendered).toContain("Process the files carefully");
  });

  test("appends args when no $ARGUMENTS placeholder", () => {
    const skill = makeSkill("my-skill", { body: "Do the thing" });
    const rendered = renderACPSkillInvocation({ skill, args: "extra" });
    expect(rendered).toContain("Arguments: extra");
  });
});

describe("toSlashCommand", () => {
  test("marks kind as skill", () => {
    const skill = makeSkill("my-skill");
    const cmd = toSlashCommand(skill);
    expect(cmd.kind).toBe("skill");
    expect(cmd.name).toBe("my-skill");
  });
});

function makeSkill(name: string, overrides?: Partial<DiscoveredACPSkill>): DiscoveredACPSkill {
  return {
    name,
    description: `The ${name} skill`,
    argumentHint: "",
    body: `Body of ${name}`,
    source: `/path/${name}/SKILL.md`,
    ...overrides,
  };
}

async function withSandbox(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "acp-skills-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
