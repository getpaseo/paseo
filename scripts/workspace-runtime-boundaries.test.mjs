import { execFile } from "node:child_process";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import { promisify } from "node:util";

import { findWorkspaceBoundaryViolations } from "./check-workspace-runtime-boundaries.mjs";

const run = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const oxlint = path.join(repoRoot, "node_modules/.bin/oxlint");

test("Paseo owns only the public runtime packages and generic fixture", async () => {
  const rootPackage = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.ok(rootPackage.workspaces.includes("packages/workspace-helper"));
  assert.ok(rootPackage.workspaces.includes("packages/workspace-runtime-contract"));
  assert.ok(rootPackage.workspaces.includes("runtimes/fixture"));
  assert.ok(!rootPackage.workspaces.includes("runtimes/*"));
  for (const script of [
    "build:docker-workspace-runtime",
    "build:docker-workspace-runtime:clean",
    "build:srt-workspace-runtime",
  ]) {
    assert.equal(rootPackage.scripts?.[script], undefined);
  }

  await assert.rejects(access(path.join(repoRoot, "packages/server/src/server/workspace-helper")));
  for (const absent of [
    "packages/docker-workspace-runtime",
    "packages/fixture-workspace-runtime",
    "packages/srt-workspace-runtime",
    "runtimes/docker",
    "runtimes/srt",
  ]) {
    await assert.rejects(access(path.join(repoRoot, absent)), absent);
  }

  const helper = JSON.parse(
    await readFile(path.join(repoRoot, "packages/workspace-helper/package.json"), "utf8"),
  );
  assert.equal(helper.name, "@getpaseo/workspace-helper");
  assert.equal(helper.private, undefined);
  assert.equal(helper.bin?.["paseo-workspace-helper"], "./dist/executable.mjs");

  const server = JSON.parse(
    await readFile(path.join(repoRoot, "packages/server/package.json"), "utf8"),
  );
  assert.ok(server.dependencies?.["@getpaseo/workspace-helper"]);
  assert.ok(server.dependencies?.["@getpaseo/workspace-runtime-contract"]);
  for (const runtime of ["docker", "fixture", "srt"]) {
    assert.equal(server.dependencies?.[`@getpaseo/${runtime}-workspace-runtime`], undefined);
  }

  const fixtureDirectory = path.join(repoRoot, "runtimes/fixture");
  const fixture = JSON.parse(await readFile(path.join(fixtureDirectory, "package.json"), "utf8"));
  for (const dependency of ["@getpaseo/workspace-runtime-contract", "@getpaseo/workspace-helper"]) {
    assert.match(fixture.dependencies?.[dependency] ?? "", /^\d+\.\d+\.\d+(?:[-+].*)?$/u);
  }
  const fixtureSources = await collectRuntimeSources(fixtureDirectory);
  assert.doesNotMatch(
    fixtureSources,
    /packages\/(?:server|app|cli|desktop|test-utils)|@getpaseo\/server|docker|sandbox-runtime|\bsrt\b/iu,
  );

  const lockfile = await readFile(path.join(repoRoot, "package-lock.json"), "utf8");
  assert.doesNotMatch(
    lockfile,
    /node_modules\/@getpaseo\/(?:docker|srt)-workspace-runtime|"runtimes\/(?:docker|srt)"/u,
  );

  for (const relativePath of [
    ".github/ci-paths.yml",
    ".github/workflows/ci.yml",
    ".github/workflows/docker.yml",
    "docs/architecture.md",
    "docs/docker.md",
    "public-docs/configuration.md",
  ]) {
    const contents = await readFile(path.join(repoRoot, relativePath), "utf8");
    assert.doesNotMatch(contents, /runtimes\/(?:docker|srt)/u, relativePath);
  }
});

test("Oxlint rejects static host imports, re-exports, aliases, and internal package paths", async (t) => {
  const root = await fixtureRoot(t);
  await copyFile(path.join(repoRoot, ".oxlintrc.json"), path.join(root, ".oxlintrc.json"));
  await source(
    root,
    "packages/server/src/server/session/workspace-scripts/forbidden.ts",
    'import { spawn } from "child_process";\n' +
      'import { readFile } from "node:fs/promises";\n' +
      'import { createRequire as makeRequire } from "node:module";\n' +
      "const renamedLoader = makeRequire(import.meta.url);\n" +
      'renamedLoader("child_process");\n' +
      'renamedLoader("fs");\n' +
      'renamedLoader("@getpaseo/server/workspace-runtime/internal/service.js");\n' +
      'export * from "@getpaseo/server/workspace-runtime/internal/service.js";\n' +
      'export * from "@getpaseo/server/workspace-runtime/command/internal/command-runtime.js";\n' +
      'export * from "@getpaseo/server/workspace-runtime/git-observation/internal/integration.js";\n' +
      'export { default as helper } from "@getpaseo/workspace-helper/internal/client.js";\n' +
      "void spawn; void readFile;\n",
  );
  await source(
    root,
    "runtimes/fixture/src/forbidden.mjs",
    'import "@getpaseo/server/workspace-runtime/command/internal/command-runtime.js";\n' +
      'import { createRequire as externalRequire } from "module";\n' +
      "const fixtureLoader = externalRequire(import.meta.url);\n" +
      'fixtureLoader("node:fs");\n' +
      'export * from "@getpaseo/workspace-helper/internal/client.js";\n',
  );

  const error = await captureFailure(run(oxlint, ["packages", "runtimes"], { cwd: root }));
  const output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  assert.match(output, /child_process/);
  assert.match(output, /node:fs\/promises/);
  assert.match(output, /node:module/);
  assert.match(output, /module/);
  assert.match(output, /workspace-runtime\/internal/);
  assert.match(output, /workspace-runtime\/command\/internal/);
  assert.match(output, /git-observation\/internal/);
  assert.match(output, /workspace-helper\/internal/);
});

test("the AST guard rejects computed loading and dynamic host/internal bypasses", async (t) => {
  const root = await fixtureRoot(t);
  await source(
    root,
    "packages/server/src/server/session/workspace-scripts/forbidden.ts",
    'import type { WorkspaceRuntimeService } from "../../workspace-runtime/index.js";\n' +
      'require("fs");\n' +
      'import("node:child_process");\n' +
      'const { createRequire: makeLoader } = require("module");\n' +
      'const renamedLoader = makeLoader(import.meta.url); renamedLoader("fs");\n' +
      'require("node:" + "fs/promises");\n' +
      "import(`@getpaseo/server/${segment}`);\n",
  );
  await source(
    root,
    "packages/server/src/server/session/business.ts",
    'require("@getpaseo/server/workspace-runtime/command/internal/command-runtime.js");\n',
  );
  await source(
    root,
    "runtimes/fixture/src/forbidden.mjs",
    'require("../../../packages/server/src/server/workspace-runtime/internal/service.js");\n' +
      'import("@getpaseo/" + packageName);\n',
  );

  const violations = await findWorkspaceBoundaryViolations(root);
  assert.deepEqual(
    violations.map(({ rule }) => rule).sort(),
    [
      "external-runtime-contract",
      "module-entrypoint",
      "module-entrypoint",
      "nonliteral-module-load",
      "nonliteral-module-load",
      "nonliteral-module-load",
      "workspace-host-access",
      "workspace-host-access",
      "workspace-host-access",
      "workspace-host-access",
    ].sort(),
  );
});

test("the AST guard rejects server access to runtime packages and source roots", async (t) => {
  const root = await fixtureRoot(t);
  await source(
    root,
    "packages/server/src/server/runtime-bypass.ts",
    'import "@getpaseo/docker-workspace-runtime";\n' +
      'export * from "@getpaseo/srt-workspace-runtime";\n' +
      'import "../../../../../../paseo-workspace-runtime-docker/src/index.ts";\n' +
      'export * from "../../../../../../paseo-workspace-runtime-srt/src/index.mjs";\n' +
      'const packageName = "@getpaseo/" + "fixture-workspace-runtime";\n' +
      'const sourceRoot = "../../../../runtimes/" + "docker/src/index.ts";\n' +
      "const load = require;\n" +
      "void load(packageName);\n" +
      "void import(sourceRoot);\n",
  );

  const violations = await findWorkspaceBoundaryViolations(root);
  assert.equal(violations.length, 6);
  assert.deepEqual(violations.map(({ rule }) => rule).sort(), [
    "nonliteral-module-load",
    "nonliteral-module-load",
    "server-runtime-access",
    "server-runtime-access",
    "server-runtime-access",
    "server-runtime-access",
  ]);
  assert.deepEqual(
    new Set(violations.map((violation) => violation.import)),
    new Set([
      "@getpaseo/docker-workspace-runtime",
      "@getpaseo/srt-workspace-runtime",
      "../../../../../../paseo-workspace-runtime-docker/src/index.ts",
      "../../../../../../paseo-workspace-runtime-srt/src/index.mjs",
      "<computed>",
    ]),
  );
});

test("the AST guard rejects every nonliteral production server load", async (t) => {
  const root = await fixtureRoot(t);
  await source(
    root,
    "packages/server/src/server/nonliteral-runtime-load.ts",
    'const target = ["@getpaseo/docker", "-workspace-runtime"].join("");\n' +
      "void import(target);\n",
  );

  assert.deepEqual(await findWorkspaceBoundaryViolations(root), [
    {
      file: "packages/server/src/server/nonliteral-runtime-load.ts",
      import: "<computed>",
      rule: "nonliteral-module-load",
      message:
        "packages/server/src/server/nonliteral-runtime-load.ts: nonliteral-module-load forbids <computed>",
    },
  ]);
});

test("the AST guard follows createRequire factory origins and chained aliases", async (t) => {
  const root = await fixtureRoot(t);
  await source(
    root,
    "packages/server/src/server/named-create-require.ts",
    'import { createRequire } from "node:module";\n' +
      "const makeLoader = createRequire;\n" +
      "const load = makeLoader(import.meta.url);\n" +
      "void load(process.env.RUNTIME);\n",
  );
  await source(
    root,
    "packages/server/src/server/namespace-create-require.ts",
    'import * as moduleApi from "node:module";\n' +
      "const makeLoader = moduleApi.createRequire;\n" +
      "const makeLoaderAlias = makeLoader;\n" +
      "const load = makeLoaderAlias(import.meta.url);\n" +
      "const loadAlias = load;\n" +
      "void loadAlias(process.env.RUNTIME);\n" +
      'const computedFactory = moduleApi["createRequire"];\n' +
      "const computedLoad = computedFactory(import.meta.url);\n" +
      "void computedLoad(process.env.RUNTIME);\n",
  );
  await source(
    root,
    "packages/server/src/server/commonjs-create-require.ts",
    'const moduleApi = require("node:module");\n' +
      "const makeLoader = moduleApi.createRequire;\n" +
      "const makeLoaderAlias = makeLoader;\n" +
      "const load = makeLoaderAlias(import.meta.url);\n" +
      "const loadAlias = load;\n" +
      "void loadAlias(process.env.RUNTIME);\n" +
      "const computedFactory = moduleApi[`createRequire`];\n" +
      "const computedLoad = computedFactory(import.meta.url);\n" +
      "void computedLoad(process.env.RUNTIME);\n",
  );

  const violations = await findWorkspaceBoundaryViolations(root);
  assert.equal(violations.length, 5);
  assert.deepEqual(
    violations.map(({ file, rule }) => ({ file, rule })),
    [
      {
        file: "packages/server/src/server/commonjs-create-require.ts",
        rule: "nonliteral-module-load",
      },
      {
        file: "packages/server/src/server/commonjs-create-require.ts",
        rule: "nonliteral-module-load",
      },
      {
        file: "packages/server/src/server/named-create-require.ts",
        rule: "nonliteral-module-load",
      },
      {
        file: "packages/server/src/server/namespace-create-require.ts",
        rule: "nonliteral-module-load",
      },
      {
        file: "packages/server/src/server/namespace-create-require.ts",
        rule: "nonliteral-module-load",
      },
    ],
  );
});

test("the AST guard follows direct createRequire property calls", async (t) => {
  const root = await fixtureRoot(t);
  await source(
    root,
    "packages/server/src/server/direct-create-require.ts",
    'import * as moduleApi from "node:module";\n' +
      "const loadA = moduleApi.createRequire(import.meta.url);\n" +
      "void loadA(process.env.RUNTIME);\n" +
      "\n" +
      'const moduleObject = require("node:module");\n' +
      "const loadB = moduleObject.createRequire(import.meta.url);\n" +
      "void loadB(process.env.RUNTIME);\n" +
      "\n" +
      'const loadC = moduleApi["createRequire"](import.meta.url);\n' +
      "void loadC(process.env.RUNTIME);\n" +
      "\n" +
      "const loadD = moduleApi[`createRequire`](import.meta.url);\n" +
      "void loadD(process.env.RUNTIME);\n",
  );

  const violations = await findWorkspaceBoundaryViolations(root);
  assert.equal(violations.length, 4);
  assert.ok(violations.every(({ rule }) => rule === "nonliteral-module-load"));
});

test("audited production loader exceptions are narrow", async (t) => {
  const root = await fixtureRoot(t);
  await source(
    root,
    "packages/server/src/server/plugins/plugin-process.ts",
    'import { createRequire } from "node:module";\n' +
      'const nodeRequire = createRequire("package.json");\n' +
      "function runtimeRequire(target) {\n" +
      "  return nodeRequire(target);\n" +
      "}\n" +
      "function unreviewedPluginLoad(target) {\n" +
      "  return nodeRequire(target);\n" +
      "}\n",
  );
  await source(
    root,
    "packages/server/src/server/workspace-runtime/command/internal/command-runtime.ts",
    'import { createRequire } from "node:module";\n' +
      "function resolveRuntimeCommand(target) {\n" +
      '  const moduleRequire = createRequire("package.json");\n' +
      "  return moduleRequire.resolve(target);\n" +
      "}\n" +
      "function unreviewedCommandLoad(target) {\n" +
      '  const moduleRequire = createRequire("package.json");\n' +
      "  return moduleRequire(target);\n" +
      "}\n",
  );
  await source(
    root,
    "packages/server/src/server/speech/providers/local/sherpa/sherpa-runtime-env.ts",
    'import { createRequire } from "node:module";\n' +
      "function resolveSherpaLoaderEnv(target) {\n" +
      '  const require = createRequire("package.json");\n' +
      "  return require.resolve(target);\n" +
      "}\n",
  );
  await source(
    root,
    "packages/server/src/server/speech/providers/local/sherpa/sherpa-onnx-node-loader.ts",
    "function loadWithRequire(requireFn: NodeRequire, target) {\n" +
      "  return requireFn(target);\n" +
      "}\n",
  );

  assert.deepEqual(await findWorkspaceBoundaryViolations(root), [
    {
      file: "packages/server/src/server/plugins/plugin-process.ts",
      import: "<computed>",
      rule: "nonliteral-module-load",
      message:
        "packages/server/src/server/plugins/plugin-process.ts: nonliteral-module-load forbids <computed>",
    },
    {
      file: "packages/server/src/server/workspace-runtime/command/internal/command-runtime.ts",
      import: "<computed>",
      rule: "nonliteral-module-load",
      message:
        "packages/server/src/server/workspace-runtime/command/internal/command-runtime.ts: nonliteral-module-load forbids <computed>",
    },
  ]);
});

test("the boundary guard rejects a copied helper under any runtime filename", async (t) => {
  const root = await fixtureRoot(t);
  await source(
    root,
    "runtimes/fixture/src/innocent-name.mjs",
    'const commands = ["fs-stat", "fs-list", "fs-read", "fs-write"]; void commands;\n',
  );
  assert.deepEqual(await findWorkspaceBoundaryViolations(root), [
    {
      file: "runtimes/fixture/src/innocent-name.mjs",
      import: "workspace-helper protocol",
      rule: "duplicate-workspace-helper",
      message:
        "runtimes/fixture/src/innocent-name.mjs: duplicate-workspace-helper forbids workspace-helper protocol",
    },
  ]);
});

test("the boundary guard rejects a helper protocol split across runtime files", async (t) => {
  const root = await fixtureRoot(t);
  await source(
    root,
    "runtimes/fixture/src/read-commands.mjs",
    'export const commands = ["fs-stat", "fs-list"];\n',
  );
  await source(
    root,
    "runtimes/fixture/src/write-commands.mjs",
    'export const commands = ["fs-read", "fs-write"];\n',
  );

  assert.deepEqual(await findWorkspaceBoundaryViolations(root), [
    {
      file: "runtimes/fixture",
      import: "workspace-helper protocol",
      rule: "duplicate-workspace-helper",
      message: "runtimes/fixture: duplicate-workspace-helper forbids workspace-helper protocol",
    },
  ]);
});

test("the AST guard rejects every statically resolvable provider probe internal import", async (t) => {
  const root = await fixtureRoot(t);
  await source(
    root,
    "packages/server/src/server/session/computed.ts",
    'import { createService as direct } from "../provider-probe/internal/service.js";\n' +
      'import { createService as alias } from "@getpaseo/server/provider-probe/internal/service.js";\n' +
      'export { createService } from "../provider-probe/internal/service.js";\n' +
      'const internal = "../provider-probe/" + "internal/service.js";\n' +
      "const load = require;\n" +
      'void require("../provider-probe/internal/service.js");\n' +
      'void import("../provider-probe/" + "internal/service.js");\n' +
      'void import(`../provider-probe/${"internal"}/service.js`);\n' +
      "void import(internal);\n" +
      "void load(internal);\n" +
      "void direct; void alias;\n",
  );

  const violations = await findWorkspaceBoundaryViolations(root);
  assert.equal(violations.length, 8);
  assert.deepEqual(
    new Set(violations.map(({ rule }) => rule)),
    new Set(["module-entrypoint", "nonliteral-module-load"]),
  );
  assert.deepEqual(
    new Set(violations.map((violation) => violation.import)),
    new Set([
      "../provider-probe/internal/service.js",
      "@getpaseo/server/provider-probe/internal/service.js",
      "<computed>",
    ]),
  );
});

test("owned integrations, explicit legacy code, and fixture contract imports pass", async (t) => {
  const root = await fixtureRoot(t);
  await copyFile(path.join(repoRoot, ".oxlintrc.json"), path.join(root, ".oxlintrc.json"));
  await source(
    root,
    "packages/server/src/server/workspace-runtime/index.ts",
    'import { service } from "./internal/service.js"; void service;\n',
  );
  await source(
    root,
    "packages/server/src/server/provider-probe/index.ts",
    'import { createService } from "./internal/service.js";\n' +
      'export { createProbeStore } from "./internal/probe-store.js";\n' +
      "void createService;\n",
  );
  await source(
    root,
    "packages/server/src/server/workspace-runtime/command/index.ts",
    'export * from "./internal/command-runtime.js";\n',
  );
  await source(
    root,
    "packages/server/src/server/workspace-runtime/internal/service.ts",
    'import { git } from "../git-observation/internal/integration.js";\n' +
      'import { helper } from "@getpaseo/workspace-helper";\n' +
      "export const service = [git, helper];\n",
  );
  await source(
    root,
    "packages/server/src/server/workspace-git-service.ts",
    'import { readFile } from "fs/promises"; void readFile;\n',
  );
  await source(
    root,
    "runtimes/fixture/src/index.mjs",
    'import { CommandRuntimeControlSchema } from "@getpaseo/workspace-runtime-contract";\n' +
      'import { spawn } from "node:child_process";\n' +
      'import("./nested.mjs"); void CommandRuntimeControlSchema; void spawn;\n',
  );
  await source(
    root,
    "packages/server/src/server/workspace-runtime/git-observation/internal/integration.ts",
    "export const git = 1;\n",
  );
  await source(root, "packages/workspace-helper/src/index.ts", "export const helper = 1;\n");
  await source(root, "runtimes/fixture/src/nested.mjs", "export const nested = 1;\n");

  assert.deepEqual(await findWorkspaceBoundaryViolations(root), []);
  try {
    await run(oxlint, ["packages", "runtimes"], { cwd: root });
  } catch (error) {
    assert.fail(`${error.stdout ?? ""}${error.stderr ?? ""}`);
  }
});

test("strict public schemas and helper argv reject root authority independent of syntax", async (t) => {
  await run("npm", ["run", "build", "--workspace=@getpaseo/workspace-runtime-contract"], {
    cwd: repoRoot,
  });
  const contract = await import(
    pathToFileURL(path.join(repoRoot, "packages/workspace-runtime-contract/dist/index.js"))
  );
  const key = ["ro", "ot"].join("");
  const state = { workspaceId: "workspace-01", lifecycle: "ready", [key]: "/private" };
  const schemaAlias = contract.CommandRuntimeStateSchema;
  assert.throws(() => schemaAlias.parse(state), /unrecognized key/i);
  assert.throws(
    () =>
      contract.CommandRuntimeLifecycleResponseSchema.parse({
        type: "state",
        protocolVersion: 1,
        state: { ...state },
        placement: { cwd: "/workspace" },
      }),
    /unrecognized key/i,
  );

  const root = await fixtureRoot(t);
  const helperError = await captureFailure(
    run(
      process.execPath,
      [
        path.join(repoRoot, "packages/workspace-helper/src/executable.mjs"),
        "fs-stat",
        `--${key}`,
        "/private",
        "--path",
        ".",
      ],
      { cwd: root },
    ),
  );
  assert.match(helperError.stderr, /Unknown workspace-helper argument: --root/);
});

async function captureFailure(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("Expected command to fail");
}

async function fixtureRoot(t) {
  const root = await mkdtemp(path.join(tmpdir(), "workspace-boundaries-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function source(root, relativePath, contents) {
  const filename = path.join(root, relativePath);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, contents);
}

async function collectRuntimeSources(directory) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const sources = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && /\.(?:js|mjs|ts|tsx)$/u.test(entry.name))
      .map((entry) => readFile(path.join(entry.parentPath, entry.name), "utf8")),
  );
  return sources.join("\n");
}
