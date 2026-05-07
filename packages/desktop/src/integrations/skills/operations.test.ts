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

import {
  getSkillsStatus,
  installSkills,
  PASEO_SKILL_NAMES,
  type SkillTargets,
  uninstallSkills,
  updateSkills,
} from "./operations";

interface Sandbox {
  root: string;
  targets: SkillTargets;
}

async function makeSandbox(): Promise<Sandbox> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-skills-"));
  const targets: SkillTargets = {
    sourceDir: path.join(root, "bundle"),
    agentsDir: path.join(root, "home", ".agents", "skills"),
    claudeDir: path.join(root, "home", ".claude", "skills"),
    codexDir: path.join(root, "home", ".codex", "skills"),
  };
  await fs.mkdir(targets.sourceDir, { recursive: true });
  return { root, targets };
}

async function writeFiles(rootDir: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(rootDir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, content);
  }
}

async function writeBundleSkill(
  sourceDir: string,
  name: string,
  files: Record<string, string>,
): Promise<void> {
  await writeFiles(path.join(sourceDir, name), files);
}

async function writeOnDiskSkill(
  agentsDir: string,
  name: string,
  files: Record<string, string>,
): Promise<void> {
  await writeFiles(path.join(agentsDir, name), files);
}

async function writeCurrentBundle(sourceDir: string): Promise<void> {
  await writeBundleSkill(sourceDir, "paseo", { "SKILL.md": "paseo-v1" });
  await writeBundleSkill(sourceDir, "paseo-loop", { "SKILL.md": "loop-v1" });
}

async function pathExists(p: string): Promise<boolean> {
  return fs
    .access(p)
    .then(() => true)
    .catch(() => false);
}

describe("getSkillsStatus", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await fs.rm(sandbox.root, { recursive: true, force: true });
  });

  it("returns not-installed with add ops for every bundled skill when nothing is on disk", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);

    const status = await getSkillsStatus(sandbox.targets);

    expect(status.state).toBe("not-installed");
    expect(status.ops).toEqual([
      { kind: "add", name: "paseo" },
      { kind: "add", name: "paseo-loop" },
    ]);
  });

  it("returns not-installed when only user-personal skill dirs exist (the live bug)", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);
    for (const name of ["unslop", "tdd", "devbox"]) {
      await writeOnDiskSkill(sandbox.targets.agentsDir, name, { "SKILL.md": `user-${name}` });
    }

    const status = await getSkillsStatus(sandbox.targets);

    expect(status.state).toBe("not-installed");
    expect(status.ops).toEqual([
      { kind: "add", name: "paseo" },
      { kind: "add", name: "paseo-loop" },
    ]);
  });

  it("returns up-to-date when every bundled skill matches on disk", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);
    await writeOnDiskSkill(sandbox.targets.agentsDir, "paseo", { "SKILL.md": "paseo-v1" });
    await writeOnDiskSkill(sandbox.targets.agentsDir, "paseo-loop", { "SKILL.md": "loop-v1" });

    const status = await getSkillsStatus(sandbox.targets);

    expect(status).toEqual({ state: "up-to-date", ops: [] });
  });

  it("returns drift with a single update op when one bundled file diverges", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);
    await writeOnDiskSkill(sandbox.targets.agentsDir, "paseo", { "SKILL.md": "stale" });
    await writeOnDiskSkill(sandbox.targets.agentsDir, "paseo-loop", { "SKILL.md": "loop-v1" });

    const status = await getSkillsStatus(sandbox.targets);

    expect(status.state).toBe("drift");
    expect(status.ops).toEqual([{ kind: "update", name: "paseo" }]);
  });

  it("returns drift with add ops for the bundled skills missing from disk", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);
    await writeOnDiskSkill(sandbox.targets.agentsDir, "paseo", { "SKILL.md": "paseo-v1" });

    const status = await getSkillsStatus(sandbox.targets);

    expect(status.state).toBe("drift");
    expect(status.ops).toEqual([{ kind: "add", name: "paseo-loop" }]);
  });

  it("returns drift with a delete op for a legacy skill name still on disk", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);
    await writeOnDiskSkill(sandbox.targets.agentsDir, "paseo", { "SKILL.md": "paseo-v1" });
    await writeOnDiskSkill(sandbox.targets.agentsDir, "paseo-loop", { "SKILL.md": "loop-v1" });
    await writeOnDiskSkill(sandbox.targets.agentsDir, "paseo-chat", { "SKILL.md": "chat-old" });

    const status = await getSkillsStatus(sandbox.targets);

    expect(status.state).toBe("drift");
    expect(status.ops).toEqual([{ kind: "delete", name: "paseo-chat" }]);
  });

  it("emits add + update + delete ops sorted by name when state is mixed", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);
    await writeOnDiskSkill(sandbox.targets.agentsDir, "paseo", { "SKILL.md": "stale" });
    await writeOnDiskSkill(sandbox.targets.agentsDir, "paseo-chat", { "SKILL.md": "chat-old" });

    const status = await getSkillsStatus(sandbox.targets);

    expect(status.state).toBe("drift");
    expect(status.ops).toEqual([
      { kind: "update", name: "paseo" },
      { kind: "delete", name: "paseo-chat" },
      { kind: "add", name: "paseo-loop" },
    ]);
  });
});

describe("installSkills / updateSkills", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await fs.rm(sandbox.root, { recursive: true, force: true });
  });

  it("installs from a clean machine, populates all three targets, and leaves user dirs alone", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);
    await writeOnDiskSkill(sandbox.targets.agentsDir, "unslop", { "SKILL.md": "user-unslop" });

    const status = await installSkills(sandbox.targets);

    expect(status).toEqual({ state: "up-to-date", ops: [] });
    for (const name of ["paseo", "paseo-loop"]) {
      expect(
        await fs.readFile(path.join(sandbox.targets.agentsDir, name, "SKILL.md"), "utf-8"),
      ).toBe(name === "paseo" ? "paseo-v1" : "loop-v1");
      expect(
        await fs.readFile(path.join(sandbox.targets.codexDir, name, "SKILL.md"), "utf-8"),
      ).toBe(name === "paseo" ? "paseo-v1" : "loop-v1");
      expect(await pathExists(path.join(sandbox.targets.claudeDir, name))).toBe(true);
    }
    expect(
      await fs.readFile(path.join(sandbox.targets.agentsDir, "unslop", "SKILL.md"), "utf-8"),
    ).toBe("user-unslop");
  });

  it("converges to up-to-date when state has missing + edited + legacy skills", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);
    await writeOnDiskSkill(sandbox.targets.agentsDir, "paseo", { "SKILL.md": "stale" });
    await writeOnDiskSkill(sandbox.targets.agentsDir, "paseo-chat", { "SKILL.md": "chat-old" });
    await writeOnDiskSkill(sandbox.targets.claudeDir, "paseo-chat", { "SKILL.md": "chat-old" });
    await writeOnDiskSkill(sandbox.targets.codexDir, "paseo-chat", { "SKILL.md": "chat-old" });

    const status = await updateSkills(sandbox.targets);

    expect(status).toEqual({ state: "up-to-date", ops: [] });
    expect(
      await fs.readFile(path.join(sandbox.targets.agentsDir, "paseo", "SKILL.md"), "utf-8"),
    ).toBe("paseo-v1");
    expect(
      await fs.readFile(path.join(sandbox.targets.agentsDir, "paseo-loop", "SKILL.md"), "utf-8"),
    ).toBe("loop-v1");
    for (const dir of [
      sandbox.targets.agentsDir,
      sandbox.targets.claudeDir,
      sandbox.targets.codexDir,
    ]) {
      expect(await pathExists(path.join(dir, "paseo-chat"))).toBe(false);
    }
  });

  it("is idempotent — running install twice keeps state at up-to-date", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);

    const first = await installSkills(sandbox.targets);
    const second = await installSkills(sandbox.targets);

    expect(first).toEqual({ state: "up-to-date", ops: [] });
    expect(second).toEqual({ state: "up-to-date", ops: [] });
  });
});

describe("uninstallSkills", () => {
  let sandbox: Sandbox;

  beforeEach(async () => {
    sandbox = await makeSandbox();
  });

  afterEach(async () => {
    await fs.rm(sandbox.root, { recursive: true, force: true });
  });

  it("removes every Paseo skill from all three targets and preserves user dirs", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);
    await installSkills(sandbox.targets);
    for (const name of ["unslop", "tdd", "devbox"]) {
      await writeOnDiskSkill(sandbox.targets.agentsDir, name, { "SKILL.md": `user-${name}` });
    }

    const status = await uninstallSkills(sandbox.targets);

    expect(status.state).toBe("not-installed");
    for (const name of PASEO_SKILL_NAMES) {
      expect(await pathExists(path.join(sandbox.targets.agentsDir, name))).toBe(false);
      expect(await pathExists(path.join(sandbox.targets.claudeDir, name))).toBe(false);
      expect(await pathExists(path.join(sandbox.targets.codexDir, name))).toBe(false);
    }
    for (const name of ["unslop", "tdd", "devbox"]) {
      expect(
        await fs.readFile(path.join(sandbox.targets.agentsDir, name, "SKILL.md"), "utf-8"),
      ).toBe(`user-${name}`);
    }
  });

  it("is a no-op when nothing is installed", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);

    const status = await uninstallSkills(sandbox.targets);

    expect(status.state).toBe("not-installed");
  });

  it("cleans up legacy skill names that linger in agents, claude, and codex", async () => {
    await writeCurrentBundle(sandbox.targets.sourceDir);
    for (const dir of [
      sandbox.targets.agentsDir,
      sandbox.targets.claudeDir,
      sandbox.targets.codexDir,
    ]) {
      await writeOnDiskSkill(dir, "paseo-chat", { "SKILL.md": "chat-old" });
    }

    const status = await uninstallSkills(sandbox.targets);

    expect(status.state).toBe("not-installed");
    for (const dir of [
      sandbox.targets.agentsDir,
      sandbox.targets.claudeDir,
      sandbox.targets.codexDir,
    ]) {
      expect(await pathExists(path.join(dir, "paseo-chat"))).toBe(false);
    }
  });
});
