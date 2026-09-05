#!/usr/bin/env node

import { build } from "esbuild";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "../../..");
const sourceEntry = path.join(scriptDirectory, "plugin-host-authority-conformance.ts");
const workerEntry = path.join(
  repositoryRoot,
  "packages/server/src/server/plugins/plugin-process.ts",
);
const defaultOutputDirectory = path.join(
  repositoryRoot,
  "packages/server/dist/plugin-host-conformance",
);
const artifactName = "plugin-host-conformance.mjs";
const manifestName = "plugin-host-conformance.manifest.json";
const runtimeBanner = {
  js: 'import { createRequire as __createRequire, Module as __Module } from "node:module"; const __nodePathSeparator = process.platform === "win32" ? ";" : ":"; const __conformanceNodePaths = [`${process.cwd()}/node_modules`, `${process.cwd()}/packages/server/node_modules`, process.env.NODE_PATH].filter(Boolean); process.env.NODE_PATH = __conformanceNodePaths.join(__nodePathSeparator); __Module._initPaths(); const require = __createRequire(import.meta.url);',
};
const caseIds = [
  "compiler.target-bounded-bundles",
  "runtime.compiles-loads-and-publishes-tool",
  "host.delivery.targets-live-caller-and-is-idempotent",
  "host.worktree.create-remove-enforces-ownership-and-persists",
  "host.child.create-inherits-live-caller-authority-after-mutation",
  "host.unauthorized-or-stale-selector-rejected",
  "delivery.reconnects-stable-installation-and-tombstones",
  "installation.replacement-fences-stale-generation-and-nonce-through-session",
];

function parseArgs(argv) {
  const outputIndex = argv.indexOf("--out-dir");
  const outputDirectory = outputIndex === -1 ? defaultOutputDirectory : argv[outputIndex + 1];
  if (!outputDirectory || outputDirectory.startsWith("--")) {
    throw new Error("--out-dir requires a directory");
  }
  if (argv.includes("--allow-dirty")) {
    throw new Error("--allow-dirty was removed; use --developer-allow-dirty for local work only");
  }
  return {
    outputDirectory: path.resolve(outputDirectory),
    developerAllowDirty: argv.includes("--developer-allow-dirty"),
  };
}

function git(args) {
  return execFileSync("git", args, { cwd: repositoryRoot, encoding: "utf8" }).trim();
}

function assertCleanTree(developerAllowDirty) {
  const status = git(["status", "--porcelain", "--untracked-files=all"]);
  if (status && !developerAllowDirty) {
    throw new Error(
      "Conformance build requires a clean git tree; pass --developer-allow-dirty only for local development",
    );
  }
}

function resolveWorkspaceSource(specifier) {
  const aliases = [
    ["@getpaseo/protocol", path.join(repositoryRoot, "packages/protocol/src")],
    ["@getpaseo/plugin", path.join(repositoryRoot, "packages/plugin/src")],
    ["@getpaseo/client", path.join(repositoryRoot, "packages/client/src")],
    ["@getpaseo/highlight", path.join(repositoryRoot, "packages/highlight/src")],
    ["@getpaseo/relay", path.join(repositoryRoot, "packages/relay/src")],
  ];
  for (const [packageName, packageSource] of aliases) {
    if (specifier !== packageName && !specifier.startsWith(`${packageName}/`)) continue;
    const suffix = specifier === packageName ? "index" : specifier.slice(packageName.length + 1);
    const withoutExtension = suffix.replace(/^internal\//u, "").replace(/\.(?:[cm]?js|jsx?)$/u, "");
    const candidates = [
      path.join(packageSource, withoutExtension),
      path.join(packageSource, `${withoutExtension}.ts`),
      path.join(packageSource, `${withoutExtension}.tsx`),
      path.join(packageSource, withoutExtension, "index.ts"),
    ];
    const match = candidates.find((candidate) => existsSync(candidate));
    if (match) return match;
    throw new Error(`Could not resolve workspace source import ${specifier}`);
  }
  return null;
}

const workspaceSourcePlugin = {
  name: "paseo-conformance-workspace-source",
  setup(plugin) {
    plugin.onResolve({ filter: /^@opencode-ai\/sdk\/v2\/client$/ }, () => ({
      path: path.join(
        repositoryRoot,
        "packages/server/node_modules/@opencode-ai/sdk/dist/v2/client.js",
      ),
    }));
    plugin.onResolve({ filter: /^(?:which|isexe)$/ }, (args) => ({
      path: path.join(
        repositoryRoot,
        "node_modules",
        args.path,
        args.path === "which" ? "which.js" : "index.js",
      ),
    }));
    plugin.onResolve({ filter: /^@getpaseo\// }, (args) => {
      const source = resolveWorkspaceSource(args.path);
      return source ? { path: source } : undefined;
    });
  },
};

async function buildBundle(entryPoint, options = {}) {
  return build({
    entryPoints: [entryPoint],
    bundle: true,
    metafile: true,
    write: false,
    absWorkingDir: repositoryRoot,
    platform: "node",
    target: "node20",
    format: options.format ?? "esm",
    legalComments: "none",
    logLevel: "silent",
    plugins: [workspaceSourcePlugin],
    ...(options.define ? { define: options.define } : {}),
    ...(options.banner ? { banner: options.banner } : {}),
  });
}

function relativeSourceInput(input) {
  const absolute = path.isAbsolute(input) ? input : path.resolve(repositoryRoot, input);
  if (!absolute.startsWith(`${repositoryRoot}${path.sep}`)) return null;
  const relative = path.relative(repositoryRoot, absolute);
  if (
    relative.split(path.sep).includes("node_modules") ||
    relative.split(path.sep).includes("dist")
  ) {
    return null;
  }
  if (!/\.(?:[cm]?js|[cm]?ts|jsx?|tsx?|json)$/u.test(relative)) return null;
  return relative.split(path.sep).join("/");
}

function trackedSourcePaths() {
  return git(["ls-files", "-z"])
    .split("\0")
    .filter(Boolean)
    .map((relative) => relative.split(path.sep).join("/"))
    .filter((relative) => relativeSourceInput(path.join(repositoryRoot, relative)) !== null);
}

async function sourceInputs(metafiles) {
  const paths = new Set();
  for (const metafile of metafiles) {
    for (const input of Object.keys(metafile.inputs)) {
      const relative = relativeSourceInput(input);
      if (relative) paths.add(relative);
    }
  }
  const result = {};
  for (const relative of [...paths].sort()) {
    const contents = await readFile(path.join(repositoryRoot, relative));
    result[relative] = createHash("sha256").update(contents).digest("hex");
  }
  return result;
}

async function trackedSourceInputHashes() {
  const result = {};
  for (const relative of trackedSourcePaths()) {
    const contents = await readFile(path.join(repositoryRoot, relative));
    result[relative] = createHash("sha256").update(contents).digest("hex");
  }
  return result;
}

function sourceManifestBanner(manifest) {
  return {
    js: `${runtimeBanner.js} const __PASEO_SOURCE_MANIFEST__ = ${JSON.stringify(manifest)};`,
  };
}

async function main() {
  const { outputDirectory, developerAllowDirty } = parseArgs(process.argv.slice(2));
  assertCleanTree(developerAllowDirty);
  const sourceCommit = git(["rev-parse", "HEAD"]);
  const worker = await buildBundle(workerEntry, {
    format: "esm",
    banner: runtimeBanner,
  });
  const workerSource = worker.outputFiles[0]?.text;
  if (!workerSource) throw new Error("Plugin child build produced no output");
  const rebuilt = await buildBundle(sourceEntry, {
    define: {
      __PASEO_PLUGIN_PROCESS_SOURCE__: JSON.stringify(workerSource),
    },
    banner: sourceManifestBanner({
      formatVersion: 1,
      sourceCommit,
      sourceInputs: {},
    }),
  });
  const bundleInputs = await sourceInputs([worker.metafile, rebuilt.metafile]);
  if (
    Object.keys(bundleInputs).some((input) => input.includes("/dist/") || input.startsWith("dist/"))
  ) {
    throw new Error("Conformance artifact unexpectedly contains a dist source input");
  }
  const inputs = { ...(await trackedSourceInputHashes()), ...bundleInputs };
  const sourceManifest = {
    formatVersion: 1,
    sourceCommit,
    sourceInputs: inputs,
  };
  const finalBuild = await buildBundle(sourceEntry, {
    define: {
      __PASEO_PLUGIN_PROCESS_SOURCE__: JSON.stringify(workerSource),
    },
    banner: sourceManifestBanner(sourceManifest),
  });
  const artifact = finalBuild.outputFiles[0]?.text;
  if (!artifact) throw new Error("Conformance build produced no output");
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(path.join(outputDirectory, artifactName), artifact, "utf8");
  const manifest = {
    formatVersion: 1,
    artifact: artifactName,
    sourceCommit,
    caseIds,
    sourceInputs: inputs,
  };
  await writeFile(
    path.join(outputDirectory, manifestName),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(
    `${JSON.stringify({ artifact: path.join(outputDirectory, artifactName), manifest: path.join(outputDirectory, manifestName), sourceCommit })}\n`,
  );
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
