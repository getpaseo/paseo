import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  diffSkills,
  hashBundle,
  readManifest,
  type SkillManifest,
  writeManifest,
} from "./manifest";

interface Sandbox {
  root: string;
  sourceDir: string;
  agentsDir: string;
}

async function makeSandbox(): Promise<Sandbox> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-skill-manifest-"));
  const sourceDir = path.join(root, "bundle");
  const agentsDir = path.join(root, "home", ".agents", "skills");
  await fs.mkdir(sourceDir, { recursive: true });
  return { root, sourceDir, agentsDir };
}

async function writeBundleSkill(
  sourceDir: string,
  name: string,
  files: Record<string, string>,
): Promise<void> {
  const skillDir = path.join(sourceDir, name);
  await fs.mkdir(skillDir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(skillDir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
}

describe("hashBundle", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await fs.rm(sandbox.root, { recursive: true, force: true });
  });

  it("returns sorted skills with sorted files", async () => {
    await writeBundleSkill(sandbox.sourceDir, "bravo", {
      "SKILL.md": "b",
      "references/extra.md": "x",
    });
    await writeBundleSkill(sandbox.sourceDir, "alpha", {
      "SKILL.md": "a",
    });

    const result = await hashBundle(sandbox.sourceDir, ["bravo", "alpha"]);
    expect(result.map((s) => s.name)).toEqual(["alpha", "bravo"]);
    const bravo = result.find((s) => s.name === "bravo");
    expect(bravo?.files.map((f) => f.rel)).toEqual(["SKILL.md", "references/extra.md"]);
    expect(bravo?.files[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("skips skills whose dirs do not exist", async () => {
    await writeBundleSkill(sandbox.sourceDir, "alpha", { "SKILL.md": "a" });

    const result = await hashBundle(sandbox.sourceDir, ["alpha", "missing"]);
    expect(result.map((s) => s.name)).toEqual(["alpha"]);
  });

  it("produces stable hashes for unchanged content", async () => {
    await writeBundleSkill(sandbox.sourceDir, "alpha", { "SKILL.md": "a" });
    const a = await hashBundle(sandbox.sourceDir, ["alpha"]);
    const b = await hashBundle(sandbox.sourceDir, ["alpha"]);
    expect(a).toEqual(b);
  });
});

describe("diffSkills", () => {
  it("returns 'add' for every bundle skill when there's no manifest, sorted", async () => {
    const bundle = [
      { name: "bravo", files: [{ rel: "SKILL.md", sha256: "h1" }] },
      { name: "alpha", files: [{ rel: "SKILL.md", sha256: "h2" }] },
    ];
    const ops = diffSkills(
      [...bundle].sort((a, b) => a.name.localeCompare(b.name)),
      null,
    );
    expect(ops).toEqual([
      { kind: "add", name: "alpha" },
      { kind: "add", name: "bravo" },
    ]);
  });

  it("returns no ops when manifest matches bundle exactly", () => {
    const skills = [
      {
        name: "alpha",
        files: [
          { rel: "SKILL.md", sha256: "h1" },
          { rel: "references/r.md", sha256: "h2" },
        ],
      },
    ];
    const ops = diffSkills(skills, { version: 1, skills });
    expect(ops).toEqual([]);
  });

  it("returns 'update' when a file's hash changed", () => {
    const manifest: SkillManifest = {
      version: 1,
      skills: [{ name: "alpha", files: [{ rel: "SKILL.md", sha256: "old" }] }],
    };
    const bundle = [{ name: "alpha", files: [{ rel: "SKILL.md", sha256: "new" }] }];
    expect(diffSkills(bundle, manifest)).toEqual([{ kind: "update", name: "alpha" }]);
  });

  it("returns 'update' when bundle has an added file", () => {
    const manifest: SkillManifest = {
      version: 1,
      skills: [{ name: "alpha", files: [{ rel: "SKILL.md", sha256: "h1" }] }],
    };
    const bundle = [
      {
        name: "alpha",
        files: [
          { rel: "SKILL.md", sha256: "h1" },
          { rel: "references/new.md", sha256: "h2" },
        ],
      },
    ];
    expect(diffSkills(bundle, manifest)).toEqual([{ kind: "update", name: "alpha" }]);
  });

  it("returns 'update' when manifest has a file no longer in the bundle", () => {
    const manifest: SkillManifest = {
      version: 1,
      skills: [
        {
          name: "alpha",
          files: [
            { rel: "SKILL.md", sha256: "h1" },
            { rel: "references/gone.md", sha256: "h2" },
          ],
        },
      ],
    };
    const bundle = [{ name: "alpha", files: [{ rel: "SKILL.md", sha256: "h1" }] }];
    expect(diffSkills(bundle, manifest)).toEqual([{ kind: "update", name: "alpha" }]);
  });

  it("returns 'delete' for skills only in manifest", () => {
    const manifest: SkillManifest = {
      version: 1,
      skills: [{ name: "removed", files: [{ rel: "SKILL.md", sha256: "h1" }] }],
    };
    expect(diffSkills([], manifest)).toEqual([{ kind: "delete", name: "removed" }]);
  });

  it("returns 'add' for new bundled skills", () => {
    const manifest: SkillManifest = { version: 1, skills: [] };
    const bundle = [{ name: "fresh", files: [{ rel: "SKILL.md", sha256: "h1" }] }];
    expect(diffSkills(bundle, manifest)).toEqual([{ kind: "add", name: "fresh" }]);
  });

  it("returns mixed add/update/delete sorted by name", () => {
    const manifest: SkillManifest = {
      version: 1,
      skills: [
        { name: "keep", files: [{ rel: "SKILL.md", sha256: "h1" }] },
        { name: "modify", files: [{ rel: "SKILL.md", sha256: "old" }] },
        { name: "remove", files: [{ rel: "SKILL.md", sha256: "h2" }] },
      ],
    };
    const bundle = [
      { name: "added", files: [{ rel: "SKILL.md", sha256: "h3" }] },
      { name: "keep", files: [{ rel: "SKILL.md", sha256: "h1" }] },
      { name: "modify", files: [{ rel: "SKILL.md", sha256: "new" }] },
    ];
    const ops = diffSkills(bundle, manifest);
    expect(ops).toEqual([
      { kind: "add", name: "added" },
      { kind: "update", name: "modify" },
      { kind: "delete", name: "remove" },
    ]);
  });
});

describe("readManifest", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await fs.rm(sandbox.root, { recursive: true, force: true });
  });

  it("returns null when the manifest file is missing", async () => {
    expect(await readManifest(sandbox.agentsDir)).toBeNull();
  });

  it("returns null when the manifest file is malformed JSON", async () => {
    await fs.mkdir(sandbox.agentsDir, { recursive: true });
    await fs.writeFile(path.join(sandbox.agentsDir, ".paseo-manifest.json"), "{not json");
    expect(await readManifest(sandbox.agentsDir)).toBeNull();
  });

  it("returns null when the manifest version is not 1", async () => {
    await fs.mkdir(sandbox.agentsDir, { recursive: true });
    await fs.writeFile(
      path.join(sandbox.agentsDir, ".paseo-manifest.json"),
      JSON.stringify({ version: 2, skills: [] }),
    );
    expect(await readManifest(sandbox.agentsDir)).toBeNull();
  });

  it("returns null when the shape is invalid", async () => {
    await fs.mkdir(sandbox.agentsDir, { recursive: true });
    await fs.writeFile(
      path.join(sandbox.agentsDir, ".paseo-manifest.json"),
      JSON.stringify({ version: 1, skills: [{ name: "x" }] }),
    );
    expect(await readManifest(sandbox.agentsDir)).toBeNull();
  });

  it("round-trips a written manifest", async () => {
    const m: SkillManifest = {
      version: 1,
      skills: [{ name: "alpha", files: [{ rel: "SKILL.md", sha256: "abc" }] }],
    };
    await writeManifest(sandbox.agentsDir, m);
    expect(await readManifest(sandbox.agentsDir)).toEqual(m);
  });
});

describe("writeManifest", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await fs.rm(sandbox.root, { recursive: true, force: true });
  });

  it("writes atomically (no .tmp left after write)", async () => {
    const m: SkillManifest = {
      version: 1,
      skills: [{ name: "alpha", files: [{ rel: "SKILL.md", sha256: "abc" }] }],
    };
    await writeManifest(sandbox.agentsDir, m);

    const entries = await fs.readdir(sandbox.agentsDir);
    expect(entries).toContain(".paseo-manifest.json");
    expect(entries).not.toContain(".paseo-manifest.json.tmp");

    const raw = await fs.readFile(path.join(sandbox.agentsDir, ".paseo-manifest.json"), "utf-8");
    expect(JSON.parse(raw)).toEqual(m);
  });

  it("overwrites an existing manifest atomically", async () => {
    const first: SkillManifest = {
      version: 1,
      skills: [{ name: "alpha", files: [{ rel: "SKILL.md", sha256: "h1" }] }],
    };
    const second: SkillManifest = {
      version: 1,
      skills: [{ name: "beta", files: [{ rel: "SKILL.md", sha256: "h2" }] }],
    };

    await writeManifest(sandbox.agentsDir, first);
    await writeManifest(sandbox.agentsDir, second);

    expect(await readManifest(sandbox.agentsDir)).toEqual(second);
    const entries = await fs.readdir(sandbox.agentsDir);
    expect(entries).not.toContain(".paseo-manifest.json.tmp");
  });
});
