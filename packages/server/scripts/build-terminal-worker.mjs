// Bundles the terminal worker into one file with its shell integration beside it. The daemon
// copies this directory (plus node-pty) into $PASEO_HOME/terminal-worker/ and launches the worker
// from the copy, so a worker that outlives an upgrade never loads files from the installation
// that replaced the one it came from. See docs/terminal-worker.md.
//
// Usage: node scripts/build-terminal-worker.mjs [--outdir <dir>]
// Default output: dist/server/terminal-worker/

import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

export const TERMINAL_WORKER_BUNDLE_NAME = "terminal-worker.mjs";

export async function buildTerminalWorkerBundle({ outDir }) {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await build({
    entryPoints: [path.join(packageRoot, "src/terminal/terminal-worker-process.ts")],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    // Loaded from the copy's own node_modules/ at run time.
    external: ["node-pty"],
    // Bundled CommonJS dependencies call require() for Node built-ins.
    banner: {
      js: 'import { createRequire as __terminalWorkerCreateRequire } from "node:module"; const require = __terminalWorkerCreateRequire(import.meta.url);',
    },
    outfile: path.join(outDir, TERMINAL_WORKER_BUNDLE_NAME),
    logLevel: "warning",
  });
  // terminal.ts resolves the zsh integration relative to its own module, which is the bundle.
  await cp(
    path.join(packageRoot, "src/terminal/shell-integration"),
    path.join(outDir, "shell-integration"),
    { recursive: true },
  );
}

function readOutDir(argv) {
  const index = argv.indexOf("--outdir");
  if (index === -1) return path.join(packageRoot, "dist/server/terminal-worker");
  const value = argv[index + 1];
  if (!value) throw new Error("--outdir requires a directory");
  return path.resolve(value);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await buildTerminalWorkerBundle({ outDir: readOutDir(process.argv.slice(2)) });
}
