import { execFile } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { promisify } from "node:util";

const run = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");
const packageDirectories = [
  "packages/highlight",
  "packages/plugin",
  "packages/relay",
  "packages/protocol",
  "packages/client",
  "packages/workspace-runtime-contract",
  "packages/workspace-helper",
  "packages/server",
  "packages/cli",
];

test("build:server:clean constructs public prerequisites without runtime implementations", async (t) => {
  const isolatedRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-server-clean-build-"));
  t.after(() => rm(isolatedRoot, { recursive: true, force: true }));

  await copyBuildCheckout(isolatedRoot);
  await createNodeModulesOverlay(isolatedRoot);
  await createPackageNodeModulesOverlays(isolatedRoot);

  for (const relativePath of [
    "packages/workspace-runtime-contract/dist",
    "packages/workspace-helper/dist",
    "packages/server/dist",
  ]) {
    await assert.rejects(access(path.join(isolatedRoot, relativePath)), relativePath);
  }
  await assert.rejects(access(path.join(isolatedRoot, "runtimes")));

  try {
    await run("npm", ["run", "build:server:clean"], {
      cwd: isolatedRoot,
      timeout: 120_000,
    });
  } catch (error) {
    assert.fail(`${error.stdout ?? ""}\n${error.stderr ?? ""}`);
  }

  for (const relativePath of [
    "packages/workspace-runtime-contract/dist/index.js",
    "packages/workspace-helper/dist/index.js",
    "packages/server/dist/server/server/exports.js",
    "packages/cli/dist/index.js",
  ]) {
    await access(path.join(isolatedRoot, relativePath));
  }
  await assert.rejects(access(path.join(isolatedRoot, "runtimes")));
});

test("public runtime packages construct complete tarballs from source", async (t) => {
  const isolatedRoot = await mkdtemp(path.join(os.tmpdir(), "paseo-runtime-packages-"));
  t.after(() => rm(isolatedRoot, { recursive: true, force: true }));

  await copyBuildCheckout(isolatedRoot);
  await createNodeModulesOverlay(isolatedRoot);
  await createPackageNodeModulesOverlays(isolatedRoot);

  for (const relativePath of [
    "packages/workspace-runtime-contract/dist",
    "packages/workspace-helper/dist",
  ]) {
    await assert.rejects(access(path.join(isolatedRoot, relativePath)), relativePath);
  }

  const packDirectory = path.join(isolatedRoot, "packs");
  await mkdir(packDirectory);
  const packages = [
    {
      workspace: "@getpaseo/workspace-runtime-contract",
      files: ["dist/index.js", "dist/index.d.ts"],
    },
    {
      workspace: "@getpaseo/workspace-helper",
      files: ["dist/index.js", "dist/index.d.ts", "dist/executable.mjs"],
      executable: "dist/executable.mjs",
    },
  ];

  for (const expected of packages) {
    const packed = JSON.parse(
      (
        await run(
          "npm",
          [
            "pack",
            "--json",
            `--workspace=${expected.workspace}`,
            "--pack-destination",
            packDirectory,
          ],
          { cwd: isolatedRoot, timeout: 120_000 },
        )
      ).stdout,
    )[0];
    const files = new Map(packed.files.map((file) => [file.path, file]));
    for (const expectedFile of expected.files) assert.ok(files.has(expectedFile), expectedFile);
    if (expected.executable) assert.equal(files.get(expected.executable)?.mode, 0o755);
    await access(path.join(packDirectory, packed.filename));
  }
});

async function copyBuildCheckout(isolatedRoot) {
  await Promise.all([
    ...["package.json", "package-lock.json", "tsconfig.base.json", "tsconfig.json"].map((file) =>
      cp(path.join(repoRoot, file), path.join(isolatedRoot, file)),
    ),
    cp(path.join(repoRoot, "scripts"), path.join(isolatedRoot, "scripts"), {
      recursive: true,
      filter: excludesBuildOutput,
    }),
    ...packageDirectories.map(async (relativeDirectory) => {
      const target = path.join(isolatedRoot, relativeDirectory);
      await mkdir(path.dirname(target), { recursive: true });
      await cp(path.join(repoRoot, relativeDirectory), target, {
        recursive: true,
        filter: excludesBuildOutput,
      });
    }),
  ]);
}

function excludesBuildOutput(source) {
  return (
    !source.endsWith(`${path.sep}dist`) &&
    !source.endsWith(`${path.sep}node_modules`) &&
    !source.endsWith(`${path.sep}test-results`)
  );
}

async function createNodeModulesOverlay(isolatedRoot) {
  const sourceModules = path.join(repoRoot, "node_modules");
  const targetModules = path.join(isolatedRoot, "node_modules");
  const workspaces = await isolatedWorkspaces(isolatedRoot);
  const internalScopes = new Set(workspaces.map(({ name }) => name.split("/")[0]));
  await mkdir(targetModules);
  await overlayModules(sourceModules, targetModules, internalScopes);

  for (const { relativeDirectory, name } of workspaces) {
    const [scope, packageName] = name.split("/");
    const internalScope = path.join(targetModules, scope);
    await mkdir(internalScope, { recursive: true });
    await symlink(
      path.join(isolatedRoot, relativeDirectory),
      path.join(internalScope, packageName),
      "dir",
    );
  }
}

async function createPackageNodeModulesOverlays(isolatedRoot) {
  const internalScopes = new Set(
    (await isolatedWorkspaces(isolatedRoot)).map(({ name }) => name.split("/")[0]),
  );
  for (const relativeDirectory of packageDirectories) {
    const sourceModules = path.join(repoRoot, relativeDirectory, "node_modules");
    try {
      await access(sourceModules);
    } catch {
      continue;
    }
    const targetModules = path.join(isolatedRoot, relativeDirectory, "node_modules");
    await mkdir(targetModules);
    await overlayModules(sourceModules, targetModules, internalScopes);
  }
}

async function isolatedWorkspaces(isolatedRoot) {
  return Promise.all(
    packageDirectories.map(async (relativeDirectory) => ({
      relativeDirectory,
      name: JSON.parse(
        await readFile(path.join(isolatedRoot, relativeDirectory, "package.json"), "utf8"),
      ).name,
    })),
  );
}

async function overlayModules(sourceModules, targetModules, internalScopes) {
  for (const entry of await readdir(sourceModules, { withFileTypes: true })) {
    if (internalScopes.has(entry.name)) continue;
    await symlink(
      path.join(sourceModules, entry.name),
      path.join(targetModules, entry.name),
      entry.isDirectory() ? "dir" : "file",
    );
  }
}
