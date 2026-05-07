import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: vi.fn(() => "/tmp/paseo-user-data"),
    isPackaged: false,
  },
}));

vi.mock("electron-log/main", () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  getSkillsStatus,
  installSkills,
  migrateLegacyInstallIfNeeded,
  type SkillTargets,
  uninstallSkills,
  updateSkills,
} from "./operations";

interface Sandbox {
  root: string;
  targets: SkillTargets;
}

async function makeSandbox(): Promise<Sandbox> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-integrations-"));
  const targets: SkillTargets = {
    sourceDir: path.join(root, "bundle"),
    agentsDir: path.join(root, "home", ".agents", "skills"),
    claudeDir: path.join(root, "home", ".claude", "skills"),
    codexDir: path.join(root, "home", ".codex", "skills"),
  };
  await fs.mkdir(targets.sourceDir, { recursive: true });
  return { root, targets };
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

describe("getSkillsStatus", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await fs.rm(sandbox.root, { recursive: true, force: true });
  });

  it("reports 'fresh' when no manifest exists and no skill content is on disk", async () => {
    await writeBundleSkill(sandbox.targets.sourceDir, "paseo", { "SKILL.md": "x" });

    const status = await getSkillsStatus(sandbox.targets);
    expect(status.state).toBe("fresh");
    expect(status.ops.find((op) => op.name === "paseo")).toEqual({ kind: "add", name: "paseo" });
  });

  it("reports 'drift' when no manifest but skill content exists on disk", async () => {
    await writeBundleSkill(sandbox.targets.sourceDir, "paseo", { "SKILL.md": "x" });
    await fs.mkdir(path.join(sandbox.targets.agentsDir, "paseo"), { recursive: true });
    await fs.writeFile(path.join(sandbox.targets.agentsDir, "paseo", "SKILL.md"), "old");

    const status = await getSkillsStatus(sandbox.targets);
    expect(status.state).toBe("drift");
  });

  it("reports 'up-to-date' after installSkills with an unchanged bundle", async () => {
    await writeBundleSkill(sandbox.targets.sourceDir, "paseo", { "SKILL.md": "content" });
    await installSkills(sandbox.targets);

    const status = await getSkillsStatus(sandbox.targets);
    expect(status.state).toBe("up-to-date");
    expect(status.ops).toEqual([]);
  });

  it("reports 'drift' when manifest exists but bundle content has changed", async () => {
    await writeBundleSkill(sandbox.targets.sourceDir, "paseo", { "SKILL.md": "v1" });
    await installSkills(sandbox.targets);

    await fs.writeFile(path.join(sandbox.targets.sourceDir, "paseo", "SKILL.md"), "v2");

    const status = await getSkillsStatus(sandbox.targets);
    expect(status.state).toBe("drift");
    expect(status.ops).toEqual([{ kind: "update", name: "paseo" }]);
  });
});

describe("installSkills + updateSkills + uninstallSkills", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await fs.rm(sandbox.root, { recursive: true, force: true });
  });

  it("installs all bundled skills and writes a manifest", async () => {
    await writeBundleSkill(sandbox.targets.sourceDir, "paseo", { "SKILL.md": "content" });
    await writeBundleSkill(sandbox.targets.sourceDir, "paseo-loop", { "SKILL.md": "loop" });

    const status = await installSkills(sandbox.targets);

    expect(status.state).toBe("up-to-date");
    expect(
      await fs.readFile(path.join(sandbox.targets.agentsDir, "paseo", "SKILL.md"), "utf-8"),
    ).toBe("content");
    expect(
      await fs.readFile(path.join(sandbox.targets.agentsDir, ".paseo-manifest.json"), "utf-8"),
    ).toContain("paseo");
  });

  it("updateSkills applies adds, updates, and deletes against the bundle", async () => {
    await writeBundleSkill(sandbox.targets.sourceDir, "paseo", { "SKILL.md": "v1" });
    await writeBundleSkill(sandbox.targets.sourceDir, "paseo-orchestrate", {
      "SKILL.md": "old-skill",
    });
    await installSkills(sandbox.targets);

    await fs.writeFile(path.join(sandbox.targets.sourceDir, "paseo", "SKILL.md"), "v2");
    await fs.rm(path.join(sandbox.targets.sourceDir, "paseo-orchestrate"), {
      recursive: true,
      force: true,
    });
    await writeBundleSkill(sandbox.targets.sourceDir, "paseo-loop", {
      "SKILL.md": "loop",
    });

    const status = await updateSkills(sandbox.targets);
    expect(status.state).toBe("up-to-date");

    expect(
      await fs.readFile(path.join(sandbox.targets.agentsDir, "paseo", "SKILL.md"), "utf-8"),
    ).toBe("v2");
    expect(
      await fs.readFile(path.join(sandbox.targets.agentsDir, "paseo-loop", "SKILL.md"), "utf-8"),
    ).toBe("loop");
    await expect(
      fs.access(path.join(sandbox.targets.agentsDir, "paseo-orchestrate")),
    ).rejects.toThrow();
    await expect(
      fs.access(path.join(sandbox.targets.codexDir, "paseo-orchestrate")),
    ).rejects.toThrow();
    await expect(
      fs.access(path.join(sandbox.targets.claudeDir, "paseo-orchestrate")),
    ).rejects.toThrow();
  });

  it("uninstallSkills removes manifest-tracked skills and reports 'fresh' afterwards", async () => {
    await writeBundleSkill(sandbox.targets.sourceDir, "paseo", { "SKILL.md": "content" });
    await installSkills(sandbox.targets);

    const status = await uninstallSkills(sandbox.targets);

    expect(status.state).toBe("fresh");
    await expect(fs.access(path.join(sandbox.targets.agentsDir, "paseo"))).rejects.toThrow();
    await expect(fs.access(path.join(sandbox.targets.codexDir, "paseo"))).rejects.toThrow();
    await expect(fs.access(path.join(sandbox.targets.claudeDir, "paseo"))).rejects.toThrow();
    await expect(
      fs.access(path.join(sandbox.targets.agentsDir, ".paseo-manifest.json")),
    ).rejects.toThrow();
  });

  it("uninstallSkills preserves user skills not tracked by the manifest", async () => {
    await writeBundleSkill(sandbox.targets.sourceDir, "paseo", { "SKILL.md": "content" });
    await installSkills(sandbox.targets);

    const userSkillDir = path.join(sandbox.targets.agentsDir, "user-custom");
    await fs.mkdir(userSkillDir, { recursive: true });
    await fs.writeFile(path.join(userSkillDir, "SKILL.md"), "user");

    await uninstallSkills(sandbox.targets);

    expect(await fs.readFile(path.join(userSkillDir, "SKILL.md"), "utf-8")).toBe("user");
    await expect(fs.access(path.join(sandbox.targets.agentsDir, "paseo"))).rejects.toThrow();
  });
});

describe("migrateLegacyInstallIfNeeded", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await fs.rm(sandbox.root, { recursive: true, force: true });
  });

  async function writeOnDiskSkill(name: string, files: Record<string, string>): Promise<void> {
    const dir = path.join(sandbox.targets.agentsDir, name);
    await fs.mkdir(dir, { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(dir, rel);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content);
    }
  }

  it("flips an existing user (skills on disk, no manifest) to up-to-date when disk matches bundle", async () => {
    await writeBundleSkill(sandbox.targets.sourceDir, "paseo", { "SKILL.md": "v1" });
    await writeBundleSkill(sandbox.targets.sourceDir, "paseo-loop", { "SKILL.md": "loop" });
    await writeOnDiskSkill("paseo", { "SKILL.md": "v1" });
    await writeOnDiskSkill("paseo-loop", { "SKILL.md": "loop" });

    const result = await migrateLegacyInstallIfNeeded(sandbox.targets);
    expect(result).toEqual({ migrated: true, skillCount: 2 });

    const status = await getSkillsStatus(sandbox.targets);
    expect(status).toEqual({ state: "up-to-date", ops: [] });

    const manifest = JSON.parse(
      await fs.readFile(path.join(sandbox.targets.agentsDir, ".paseo-manifest.json"), "utf-8"),
    );
    expect(manifest.version).toBe(1);
    expect(manifest.skills.map((s: { name: string }) => s.name)).toEqual(["paseo", "paseo-loop"]);
  });

  it("reports drift with an update op for a user-edited skill", async () => {
    await writeBundleSkill(sandbox.targets.sourceDir, "paseo", { "SKILL.md": "bundle-v1" });
    await writeOnDiskSkill("paseo", { "SKILL.md": "user-edited" });

    const status = await getSkillsStatus(sandbox.targets);
    expect(status.state).toBe("drift");
    expect(status.ops).toEqual([{ kind: "update", name: "paseo" }]);
  });

  it("is a no-op and does not overwrite when manifest already exists", async () => {
    await writeBundleSkill(sandbox.targets.sourceDir, "paseo", { "SKILL.md": "v1" });
    await installSkills(sandbox.targets);

    const before = await fs.readFile(
      path.join(sandbox.targets.agentsDir, ".paseo-manifest.json"),
      "utf-8",
    );

    const result = await migrateLegacyInstallIfNeeded(sandbox.targets);
    expect(result).toEqual({ migrated: false, skillCount: 0 });

    const after = await fs.readFile(
      path.join(sandbox.targets.agentsDir, ".paseo-manifest.json"),
      "utf-8",
    );
    expect(after).toBe(before);
  });

  it("is a no-op when no manifest and no on-disk skills (genuinely fresh)", async () => {
    await writeBundleSkill(sandbox.targets.sourceDir, "paseo", { "SKILL.md": "v1" });

    const result = await migrateLegacyInstallIfNeeded(sandbox.targets);
    expect(result).toEqual({ migrated: false, skillCount: 0 });

    await expect(
      fs.access(path.join(sandbox.targets.agentsDir, ".paseo-manifest.json")),
    ).rejects.toThrow();

    const status = await getSkillsStatus(sandbox.targets);
    expect(status.state).toBe("fresh");
  });

  it("ignores non-paseo directories on disk when nothing tracked exists", async () => {
    await writeBundleSkill(sandbox.targets.sourceDir, "paseo", { "SKILL.md": "v1" });
    await fs.mkdir(path.join(sandbox.targets.agentsDir, "user-custom"), { recursive: true });
    await fs.writeFile(path.join(sandbox.targets.agentsDir, "user-custom", "SKILL.md"), "mine");

    const result = await migrateLegacyInstallIfNeeded(sandbox.targets);
    expect(result).toEqual({ migrated: false, skillCount: 0 });

    await expect(
      fs.access(path.join(sandbox.targets.agentsDir, ".paseo-manifest.json")),
    ).rejects.toThrow();
  });

  it("is idempotent across two getSkillsStatus calls", async () => {
    await writeBundleSkill(sandbox.targets.sourceDir, "paseo", { "SKILL.md": "v1" });
    await writeOnDiskSkill("paseo", { "SKILL.md": "v1" });

    const first = await getSkillsStatus(sandbox.targets);
    const manifestAfterFirst = await fs.readFile(
      path.join(sandbox.targets.agentsDir, ".paseo-manifest.json"),
      "utf-8",
    );

    const second = await getSkillsStatus(sandbox.targets);
    const manifestAfterSecond = await fs.readFile(
      path.join(sandbox.targets.agentsDir, ".paseo-manifest.json"),
      "utf-8",
    );

    expect(first).toEqual(second);
    expect(manifestAfterSecond).toBe(manifestAfterFirst);
  });
});
