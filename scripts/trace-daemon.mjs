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
import { glob } from "node:fs/promises";
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

// Daemon entry points. Workers forked into their own Node processes have
// independent require trees; nft does not follow fork boundaries, so trace
// them separately.
const entries = [
  "packages/cli/dist/index.js",
  "packages/server/dist/scripts/supervisor-entrypoint.js",
  "packages/server/dist/server/terminal/terminal-worker-process.js",
  "packages/server/dist/server/server/speech/providers/local/worker-process.js",
];

// Files read at runtime via fs APIs rather than `require`. nft only
// traces the module graph; data files have to be listed explicitly.
const additionalInputs = [
  // Shell integration scripts loaded by the terminal manager
  "packages/server/dist/server/terminal/shell-integration/**",
  // Silero VAD ONNX model (sherpa speech provider)
  "packages/server/dist/server/server/speech/providers/local/sherpa/assets/silero_vad.onnx",
  // Server runtime config files (read by path, not require)
  "packages/server/.env.example",
  // CLI shebang script wrapping dist/index.js
  "packages/cli/bin/paseo",
  // node-pty's compiled native addon. nft can't trace it because
  // node-pty loads it via `require(path.join(__dirname, 'prebuilds/<plat>/pty.node'))`
  // with a runtime-computed platform suffix. Pin to the host platform —
  // the Nix derivation builds for one platform at a time and ships only
  // its own binaries.
  `node_modules/node-pty/prebuilds/${process.platform}-${process.arch}/**`,
  // sherpa-onnx-node dynamically resolves a platform-specific native package.
  // Copy the wrapper plus the host platform package explicitly.
  "node_modules/sherpa-onnx-node/**",
  `node_modules/${sherpaPlatformPackageName()}/**`,
];

// Trace.
const { fileList, warnings } = await nodeFileTrace(entries, {
  base: REPO_ROOT,
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
      expanded.add(file);
    }
  } else {
    expanded.add(pattern);
  }
}

// Emit sorted, deduplicated.
for (const p of [...expanded].sort()) {
  console.log(p);
}
