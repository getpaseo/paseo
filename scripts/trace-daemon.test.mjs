import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { traceRuntimeClosure } from "./trace-daemon.mjs";

async function writeFixtureFile(root, relativePath, contents) {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, "utf8");
}

async function createWorkspaceFixture() {
  const rawRoot = await mkdtemp(path.join(os.tmpdir(), "trace-daemon-test-"));
  const root = await realpath(rawRoot);

  await writeFixtureFile(
    root,
    "package.json",
    JSON.stringify({ name: "fixture-root", private: true }),
  );

  // Server workspace with package exports (mirrors @getpaseo/server).
  await writeFixtureFile(
    root,
    "packages/server/package.json",
    JSON.stringify({
      name: "@fixture/server",
      version: "1.0.0",
      type: "module",
      exports: {
        ".": {
          default: "./dist/exports.js",
        },
      },
    }),
  );
  await writeFixtureFile(
    root,
    "packages/server/dist/exports.js",
    'import { version } from "./dep.js";\nexport const serverVersion = version;\n',
  );
  await writeFixtureFile(root, "packages/server/dist/dep.js", 'export const version = "1.0.0";\n');

  // CLI workspace with esbuild-style aliased createRequire banner and extensionless bin script.
  await writeFixtureFile(
    root,
    "packages/cli/package.json",
    JSON.stringify({
      name: "@fixture/cli",
      version: "1.0.0",
      type: "module",
      bin: { fixture: "bin/fixture" },
    }),
  );
  await writeFixtureFile(
    root,
    "packages/cli/bin/fixture",
    '#!/usr/bin/env -S node --disable-warning=DEP0040\nimport "../dist/index.js";\n',
  );
  await writeFixtureFile(
    root,
    "packages/cli/dist/index.js",
    [
      'import { createRequire as __paseoCliCreateRequire } from "node:module";',
      "const require = __paseoCliCreateRequire(import.meta.url);",
      'export const resolveServer = () => require.resolve("@fixture/server");',
      "",
    ].join("\n"),
  );

  // Plain ESM module without createRequire (e.g. terminal.js resolving bin and package.json).
  await writeFixtureFile(
    root,
    "packages/server/dist/terminal.js",
    'export const kind = "terminal";\n',
  );

  // Native-style dependency whose package.json is resolved at runtime.
  await writeFixtureFile(
    root,
    "node_modules/fake-native/package.json",
    JSON.stringify({ name: "fake-native", version: "1.0.0", main: "index.js" }),
  );
  await writeFixtureFile(
    root,
    "node_modules/fake-native/index.js",
    "module.exports = { ok: true };\n",
  );

  // CommonJS module (mirrors packages/desktop/dist/daemon/runtime-paths.js).
  await writeFixtureFile(
    root,
    "packages/desktop/package.json",
    JSON.stringify({ name: "@fixture/desktop", version: "1.0.0" }),
  );
  await writeFixtureFile(
    root,
    "packages/desktop/dist/helper.js",
    "module.exports = { helper: true };\n",
  );
  await writeFixtureFile(
    root,
    "packages/desktop/dist/runtime-paths.js",
    'const helper = require("./helper");\nmodule.exports = { helper, resolveServer: () => require.resolve("@fixture/server") };\n',
  );

  // Workspace symlinks in node_modules.
  await mkdir(path.join(root, "node_modules/@fixture"), { recursive: true });
  await symlink("../../packages/server", path.join(root, "node_modules/@fixture/server"));
  await symlink("../../packages/cli", path.join(root, "node_modules/@fixture/cli"));

  return root;
}

test("traces runtime dependencies from an ESM bundle with aliased createRequire, plain ESM, and CJS importers", async () => {
  const root = await createWorkspaceFixture();
  const outRoot = await mkdtemp(path.join(os.tmpdir(), "trace-daemon-out-"));
  try {
    const { files } = await traceRuntimeClosure({
      repoRoot: root,
      entries: [
        "packages/cli/dist/index.js",
        "packages/server/dist/terminal.js",
        "packages/desktop/dist/runtime-paths.js",
      ],
      runtimeDependencies: new Map([
        ["packages/cli/dist/index.js", ["@fixture/server"]],
        [
          "packages/server/dist/terminal.js",
          ["@fixture/cli/bin/fixture", "fake-native/package.json"],
        ],
        ["packages/desktop/dist/runtime-paths.js", ["@fixture/server"]],
      ]),
    });

    const traced = new Set(files);
    // Aliased createRequire ESM bundle traces @fixture/server export and its transitive dependency.
    assert.ok(traced.has("packages/server/dist/exports.js"), "expected server export to be traced");
    assert.ok(
      traced.has("packages/server/dist/dep.js"),
      "expected server transitive dep to be traced",
    );
    assert.ok(traced.has("node_modules/@fixture/server"), "expected server workspace symlink");

    // Plain ESM traces extensionless bin script and JSON manifest.
    assert.ok(traced.has("packages/cli/bin/fixture"), "expected extensionless bin script");
    assert.ok(traced.has("node_modules/@fixture/cli"), "expected cli workspace symlink");
    assert.ok(traced.has("node_modules/fake-native/package.json"), "expected JSON manifest target");

    // CJS importer keeps its own require() edges when runtime dependencies are injected.
    assert.ok(
      traced.has("packages/desktop/dist/helper.js"),
      "expected CJS importer's own require() dependency to remain traced",
    );

    // Copying only the traced files into an isolated output directory preserves resolution.
    for (const file of files) {
      await cp(path.join(root, file), path.join(outRoot, file), {
        recursive: true,
        verbatimSymlinks: true,
      });
    }
    const installedServer = createRequire(path.join(outRoot, "packages/cli/dist/index.js")).resolve(
      "@fixture/server",
    );
    assert.equal(installedServer, path.join(outRoot, "packages/server/dist/exports.js"));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outRoot, { recursive: true, force: true });
  }
});

test("fails loudly naming the missing edge when a declared runtime dependency is omitted from traced output", async () => {
  const root = await createWorkspaceFixture();
  try {
    await assert.rejects(
      () =>
        traceRuntimeClosure({
          repoRoot: root,
          entries: ["packages/cli/dist/index.js"],
          runtimeDependencies: new Map([["packages/cli/dist/index.js", ["@fixture/server"]]]),
          // Simulate nft dropping the target despite Node resolving it in the repo.
          ignore: ["packages/server/dist/exports.js"],
          // Even if additionalInputs copies the file later, nft's traced output still dropped the edge.
          additionalInputs: ["packages/server/dist/exports.js"],
        }),
      (error) => {
        assert.match(error.message, /packages\/cli\/dist\/index\.js/);
        assert.match(error.message, /@fixture\/server/);
        assert.match(error.message, /packages\/server\/dist\/exports\.js/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fails loudly when a runtime dependency importer is never reached even if another importer traces the same target", async () => {
  const root = await createWorkspaceFixture();
  try {
    await assert.rejects(
      () =>
        traceRuntimeClosure({
          repoRoot: root,
          entries: ["packages/desktop/dist/runtime-paths.js"],
          runtimeDependencies: new Map([
            ["packages/desktop/dist/runtime-paths.js", ["@fixture/server"]],
            ["packages/cli/dist/index.js", ["@fixture/server"]],
          ]),
        }),
      (error) => {
        assert.match(error.message, /packages\/cli\/dist\/index\.js/);
        assert.match(error.message, /@fixture\/server/);
        assert.match(error.message, /packages\/server\/dist\/exports\.js/);
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
