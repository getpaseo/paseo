import { mkdtemp, mkdir, writeFile, rm, symlink, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverPackageScripts } from "./package-scripts.js";

describe("package script discovery", () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "paseo-package-scripts-")));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function manifest(path: string, value: unknown): Promise<void> {
    const directory = join(root, path);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "package.json"), JSON.stringify(value));
  }

  it("keeps duplicate script names distinct and inherits the root package manager", async () => {
    await manifest("", { packageManager: "pnpm@10.0.0", scripts: { build: "tsc" } });
    await manifest("packages/web", { scripts: { build: "vite build" } });
    await manifest("packages/api", {
      packageManager: "bun@1.0.0",
      scripts: { build: "bun build" },
    });
    const scripts = [...(await discoverPackageScripts(root)).values()];
    expect(scripts).toEqual([
      {
        command: "pnpm run 'build'",
        cwd: root,
        packageJson: { path: "package.json", script: "build" },
      },
      {
        command: "bun run 'build'",
        cwd: join(root, "packages/api"),
        packageJson: { path: "packages/api/package.json", script: "build" },
      },
      {
        command: "pnpm run 'build'",
        cwd: join(root, "packages/web"),
        packageJson: { path: "packages/web/package.json", script: "build" },
      },
    ]);
    expect((await discoverPackageScripts(root)).size).toBe(3);
  });

  it("excludes dependency, generated, hidden and symlinked directories", async () => {
    for (const path of ["node_modules/pkg", "dist/pkg", "build/pkg", ".git/pkg", ".dev/pkg"]) {
      await manifest(path, { scripts: { hidden: "echo no" } });
    }
    await manifest("src/tool", { scripts: { test: "echo yes" } });
    await symlink(root, join(root, "loop"), "dir");
    expect(
      [...(await discoverPackageScripts(root)).values()].map((script) => script.packageJson.path),
    ).toEqual(["src/tool/package.json"]);
  });

  it("refreshes additions, removals and lockfile selection", async () => {
    await manifest("", { scripts: { build: "echo one" } });
    expect([...(await discoverPackageScripts(root)).values()][0]?.command).toBe("npm run 'build'");
    await writeFile(join(root, "yarn.lock"), "");
    await manifest("", { scripts: { test: "echo two" } });
    expect([...(await discoverPackageScripts(root)).values()]).toEqual([
      {
        command: "yarn run 'test'",
        cwd: root,
        packageJson: { path: "package.json", script: "test" },
      },
    ]);
  });

  it("reports a malformed manifest instead of returning an empty successful list", async () => {
    await writeFile(join(root, "package.json"), "{");
    await expect(discoverPackageScripts(root)).rejects.toThrow();
  });
});
