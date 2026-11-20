#!/usr/bin/env node
// Emit the set of files the daemon and CLI need at runtime, computed by
// static module-graph tracing (@vercel/nft) from the daemon entry points.
// Used by nix/package.nix's installPhase to materialize $out/lib/paseo
// with only the bytes the daemon actually loads — no Expo, RN, Metro,
// Electron, ML stacks, or other non-daemon workspace bloat.
//
// Output: newline-separated repo-relative file paths on stdout. The Nix
// installPhase copies each path to $out/lib/paseo/<path>, preserving the
// directory structure node's module resolution expects.
//
// Run from the repo root, after `npm run build:server`. Requires
// node_modules populated (the Nix build invokes this post-configHook).

import { nodeFileTrace } from "@vercel/nft";
import { glob, readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

const { sherpaPlatformPackageName } = await import(
  pathToFileURL(
    path.join(
      REPO_ROOT,
      "packages/server/dist/server/server/speech/providers/local/sherpa/sherpa-runtime-env.js",
    ),
  ).href
);

const traceDesktop = process.env.PASEO_TRACE_DESKTOP === "1";
const terminalModule = "packages/server/dist/server/terminal/terminal.js";
const sherpaModule =
  "packages/server/dist/server/server/speech/providers/local/sherpa/sherpa-onnx-node-loader.js";
const sherpaEnvModule =
  "packages/server/dist/server/server/speech/providers/local/sherpa/sherpa-runtime-env.js";

// Resolve-only and computed requires need explicit graph edges, not installed
// paths. Analyze them at their real importer so nft retains the package exports,
// manifests and workspace symlinks used by Node's resolution.
const runtimeDependencies = new Map([
  ["packages/cli/dist/commands/daemon/local-daemon.js", ["@getpaseo/server"]],
  [terminalModule, ["@getpaseo/cli/bin/paseo", "node-pty/package.json"]],
  [sherpaModule, ["sherpa-onnx-node"]],
  [sherpaEnvModule, [`${sherpaPlatformPackageName()}/package.json`]],
  ...(traceDesktop
    ? [
        ["packages/desktop/dist/daemon/runtime-paths.js", ["@getpaseo/server"]],
        ["packages/desktop/dist/integrations/cli-install/paths.js", ["@getpaseo/cli/bin/paseo"]],
      ]
    : []),
]);

function requireFrom(importer) {
  return createRequire(path.join(REPO_ROOT, importer));
}

function resolvedPackageFiles(importer, specifier) {
  const manifest = requireFrom(importer).resolve(`${specifier}/package.json`);
  return path.join(path.dirname(manifest), "**");
}

// Let node-pty select the native build it actually loads. npm hoisting and
// prebuild/build layout are owned by the package, not this trace. Its Darwin
// spawn-helper lives beside the selected addon; retain the files in that dir.
const terminalRequire = requireFrom(terminalModule);
const ptyLoader = terminalRequire.resolve("node-pty/lib/utils");
const { dir: ptyNativeDir } = terminalRequire(ptyLoader).loadNativeModule("pty");
const ptyNativeRoot = path.resolve(path.dirname(ptyLoader), ptyNativeDir);
const ptyNativeFiles = (await readdir(ptyNativeRoot, { withFileTypes: true }))
  .filter((entry) => entry.isFile())
  .map((entry) => path.join(ptyNativeRoot, entry.name));

// Daemon entry points. Workers forked into their own Node processes have
// independent require trees; nft does not follow fork boundaries, so trace
// them separately. The desktop derivation opts into tracing its Electron main
// process and preloads as well.
const entries = [
  "packages/cli/dist/index.js",
  "packages/server/dist/scripts/supervisor-entrypoint.js",
  "packages/server/dist/server/terminal/terminal-worker-process.js",
  "packages/server/dist/server/server/speech/providers/local/worker-process.js",
  ...(traceDesktop
    ? [
        "packages/desktop/dist/main.js",
        "packages/desktop/dist/preload.js",
        "packages/desktop/dist/features/browser-keyboard/guest-preload.js",
      ]
    : []),
];

// Files read at runtime via fs APIs rather than `require`. nft only
// traces the module graph; data files have to be listed explicitly.
const additionalInputs = [
  // Agent orchestration skill catalog loaded through filesystem paths
  "packages/server/dist/server/skills/**",
  "packages/server/dist/server/builtin-plugins/**",
  // Shell integration scripts loaded by the terminal manager
  "packages/server/dist/server/terminal/shell-integration/**",
  // Silero VAD ONNX model (sherpa speech provider)
  "packages/server/dist/server/server/speech/providers/local/sherpa/assets/silero_vad.onnx",
  // OpenCode loads these plugins from a content-addressed runtime copy, one
  // bundle per supported OpenCode version (opencode/ and opencode/v2/).
  "packages/server/dist/server/server/agent/providers/opencode/**/bridge-plugin.bundle.mjs",
  // Server runtime config files (read by path, not require)
  "packages/server/.env.example",
  ...ptyNativeFiles,
  // Resolve native speech packages from the same modules as the runtime.
  resolvedPackageFiles(sherpaModule, "sherpa-onnx-node"),
  resolvedPackageFiles(sherpaEnvModule, sherpaPlatformPackageName()),
  ...(traceDesktop
    ? [
        // The unpackaged Nix launcher resolves these beside desktop/dist.
        "packages/desktop/package.json",
        "packages/desktop/assets/**",
      ]
    : []),
];

// Fail at build time if a required runtime edge cannot resolve.
for (const [importer, specifiers] of runtimeDependencies) {
  for (const specifier of specifiers) requireFrom(importer).resolve(specifier);
}

// Trace.
const { fileList, warnings } = await nodeFileTrace(entries, {
  base: REPO_ROOT,
  async readFile(file) {
    let source;
    try {
      source = await readFile(file);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "EISDIR") return null;
      throw error;
    }
    const dependencies = runtimeDependencies.get(path.relative(REPO_ROOT, file));
    if (!dependencies) return source;
    // These statements exist only in nft's input, never in the shipped code.
    return `${source}\n${dependencies.map((specifier) => `require(${JSON.stringify(specifier)});`).join("\n")}`;
  },
  // Tolerate the conditional / dynamic patterns we already audited:
  // sherpa-onnx-${platform}-${arch} package resolution (the host package
  // is copied explicitly above), and a handful of test-only requires that
  // get tree-shaken out by tsc.
  ignore: [
    // Cross-platform native packages for the sherpa speech runtime;
    // only the host platform package is needed at runtime.
    "sherpa-onnx-*/**",
    // Platform-specific clipboard variants; only the host's variant
    // is needed at runtime, and the package's index.js resolver picks
    // the right one dynamically.
    "@mariozechner/clipboard-*/**",
    // node-fetch optional peer for non-UTF-8 charset decoding; not
    // loaded in our usage.
    "encoding/**",
    // Tests are stripped during the daemon build; nft sometimes still
    // tries to walk into them via index files. Belt and suspenders.
    "**/*.test.js",
    "**/*.e2e.test.js",
    // The Nix desktop package runs under nixpkgs' Electron. Tracing the npm
    // package would duplicate the complete Electron distribution in $out.
    ...(traceDesktop ? ["node_modules/electron/**"] : []),
  ],
});

// Surface non-trivial trace warnings so the Nix build log captures them.
for (const w of warnings) {
  // Drop the "Failed to resolve dependency" noise for things we
  // explicitly ignore above.
  const msg = w.message ?? String(w);
  if (/sherpa-onnx-/.test(msg)) continue;
  console.error("trace warning:", msg);
}

// Expand globs in additionalInputs.
const expanded = new Set(fileList);
for (const pattern of additionalInputs) {
  if (pattern.includes("*")) {
    for await (const file of glob(pattern, { cwd: REPO_ROOT })) {
      expanded.add(path.relative(REPO_ROOT, path.resolve(REPO_ROOT, file)));
    }
  } else {
    expanded.add(path.relative(REPO_ROOT, path.resolve(REPO_ROOT, pattern)));
  }
}

// Emit sorted, deduplicated.
for (const p of [...expanded].sort()) {
  console.log(p);
}
