import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { promisify } from "node:util";

const run = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");

test("the fixture installs and describes from isolated packed dependencies", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "paseo-runtime-fixture-standalone-"));
  const managedArtifacts = [];
  t.after(async () => {
    for (const artifact of managedArtifacts) {
      await rm(path.join(repoRoot, artifact.relativePath), { recursive: true, force: true });
    }
    for (const artifact of managedArtifacts) {
      if (artifact.hiddenPath) {
        await rename(artifact.hiddenPath, path.join(repoRoot, artifact.relativePath));
      }
    }
    await rm(root, { recursive: true, force: true });
  });
  const packs = path.join(root, "packs");
  await mkdir(packs);

  for (const relativePath of buildArtifacts) {
    const hiddenPath = path.join(root, "previous-dist", relativePath.replaceAll("/", "__"));
    try {
      await mkdir(path.dirname(hiddenPath), { recursive: true });
      await rename(path.join(repoRoot, relativePath), hiddenPath);
      managedArtifacts.push({ relativePath, hiddenPath });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      managedArtifacts.push({ relativePath, hiddenPath: null });
    }
  }
  const packageRoots = {
    contract: "packages/workspace-runtime-contract",
    helper: "packages/workspace-helper",
    fixture: "runtimes/fixture",
  };
  await run("npm", ["run", "build", "--workspace=@getpaseo/fixture-workspace-runtime"], {
    cwd: repoRoot,
  });
  const tarballs = {};
  for (const [name, relativeRoot] of Object.entries(packageRoots)) {
    const result = JSON.parse(
      (
        await run("npm", ["pack", "--json", "--pack-destination", packs], {
          cwd: path.join(repoRoot, relativeRoot),
        })
      ).stdout,
    );
    tarballs[name] = path.join(packs, result[0].filename);
  }

  const project = path.join(root, "fixture");
  await mkdir(project);
  await writeFile(
    path.join(project, "package.json"),
    JSON.stringify({
      private: true,
      dependencies: {
        "@getpaseo/workspace-runtime-contract": `file:${tarballs.contract}`,
        "@getpaseo/workspace-helper": `file:${tarballs.helper}`,
        "@getpaseo/fixture-workspace-runtime": `file:${tarballs.fixture}`,
      },
    }),
  );
  await run("npm", ["install", "--ignore-scripts"], {
    cwd: project,
    env: { ...process.env, npm_config_cache: path.join(root, "npm-cache") },
  });
  const bin = path.join(project, "node_modules/.bin/paseo-fixture-workspace-runtime");
  const description = JSON.parse((await run(bin, ["describe"], { cwd: project })).stdout);
  assert.deepEqual(description, {
    protocolVersion: 1,
    modes: ["pipes", "pty"],
    reconcile: false,
  });
  const bundledHelper = path.join(
    project,
    "node_modules/@getpaseo/fixture-workspace-runtime/dist/paseo-workspace-helper",
  );
  assert.deepEqual(JSON.parse((await run(bundledHelper, ["describe"], { cwd: project })).stdout), {
    protocolVersion: 1,
    version: 1,
    capabilities: ["files", "watch", "resolve-command"],
  });
  assert.match(
    await import("node:fs/promises").then(({ realpath }) => realpath(bin)),
    /node_modules\/@getpaseo\/fixture-workspace-runtime\//u,
  );
});

const buildArtifacts = [
  "packages/workspace-runtime-contract/dist",
  "packages/workspace-helper/dist",
  "runtimes/fixture/dist",
];
