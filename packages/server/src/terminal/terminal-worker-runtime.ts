import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { access, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePrivateDirectory } from "../server/private-files.js";
import { listTerminalWorkerRecords, terminalWorkerDirectory } from "./terminal-worker-record.js";

// A terminal worker outlives the installation that started it. An npm or desktop update
// replaces that installation's files, so a worker launched from them would fail its next
// terminal create (node-pty's spawn-helper, the zsh integration). A built daemon therefore
// copies the worker bundle, its shell integration and node-pty into
// $PASEO_HOME/terminal-worker/<paseoVersion>-<content hash>/ and launches the worker from there.
// The hash keeps two builds of one version (a local rebuild) from sharing a copy. A copy is
// removed once no worker record names it: after a worker drains, after a kill cleanup, and at
// daemon start. Dev runs (.ts source) launch from source and copy nothing.

export const TERMINAL_WORKER_BUNDLE_NAME = "terminal-worker.mjs";
// Written last into a finished copy; a directory without it is an interrupted copy.
const RUNTIME_MARKER = "paseo-terminal-worker-runtime.json";
const TEMP_PREFIX = ".tmp-";

export class TerminalWorkerRuntimeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TerminalWorkerRuntimeError";
  }
}

/** What the launcher runs: the worker script, the node flags it needs, and the copy it is in. */
export interface TerminalWorkerEntry {
  scriptPath: string;
  execArgv: string[];
  /** The copy's directory name under terminal-worker/, or null when run from source. */
  runtime: string | null;
}

function sourceExecArgv(): string[] {
  const loaderUrl = new URL("./terminal-ts-loader.mjs", import.meta.url).href;
  const importSource = [
    'import { register } from "node:module";',
    'import { pathToFileURL } from "node:url";',
    `register(${JSON.stringify(loaderUrl)}, pathToFileURL("./"));`,
  ].join(" ");
  return [
    "--experimental-strip-types",
    "--import",
    `data:text/javascript,${encodeURIComponent(importSource)}`,
  ];
}

/**
 * The entry a daemon launches its worker from: the source file in dev, otherwise a copy of the
 * built bundle in this home, prepared on demand.
 */
export function resolveTerminalWorkerEntry(input: {
  paseoHome: string;
  paseoVersion: string;
}): TerminalWorkerEntry {
  if (import.meta.url.endsWith(".ts")) {
    return {
      scriptPath: fileURLToPath(new URL("./terminal-worker-process.ts", import.meta.url)),
      execArgv: sourceExecArgv(),
      runtime: null,
    };
  }
  const bundleDirectory = fileURLToPath(new URL("../terminal-worker/", import.meta.url));
  if (!existsSync(path.join(bundleDirectory, TERMINAL_WORKER_BUNDLE_NAME))) {
    throw new TerminalWorkerRuntimeError(
      `The terminal worker bundle is missing from ${bundleDirectory}; rebuild @getpaseo/server (npm run build).`,
    );
  }
  const require = createRequire(import.meta.url);
  const nodePtyDirectory = path.dirname(require.resolve("node-pty/package.json"));
  return prepareTerminalWorkerRuntime({
    paseoHome: input.paseoHome,
    paseoVersion: input.paseoVersion,
    bundleDirectory,
    nodePtyDirectory,
  });
}

function runtimeName(input: {
  paseoVersion: string;
  bundleDirectory: string;
  nodePtyDirectory: string;
}): string {
  const hash = createHash("sha256");
  hash.update(readFileSync(path.join(input.bundleDirectory, TERMINAL_WORKER_BUNDLE_NAME)));
  hash.update(readFileSync(path.join(input.nodePtyDirectory, "package.json")));
  hash.update(`${process.platform}-${process.arch}`);
  const version = input.paseoVersion.replace(/[^A-Za-z0-9._-]/g, "_");
  return `${version}-${hash.digest("hex").slice(0, 12)}`;
}

// Plain fs calls on purpose: inside the desktop app the sources live in app.asar, which
// Electron's fs reads transparently but newer helpers like cpSync do not.
function copyTree(source: string, destination: string): void {
  const stat = statSync(source);
  if (stat.isDirectory()) {
    mkdirSync(destination, { recursive: true });
    for (const name of readdirSync(source)) {
      copyTree(path.join(source, name), path.join(destination, name));
    }
    return;
  }
  writeFileSync(destination, readFileSync(source));
  // Keeps node-pty's spawn-helper executable.
  chmodSync(destination, stat.mode & 0o777);
}

function copyNodePty(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true });
  copyTree(path.join(source, "package.json"), path.join(destination, "package.json"));
  copyTree(path.join(source, "lib"), path.join(destination, "lib"));
  const native = [
    path.join("build", "Release"),
    path.join("prebuilds", `${process.platform}-${process.arch}`),
  ].filter((relative) => existsSync(path.join(source, relative)));
  if (native.length === 0) {
    throw new TerminalWorkerRuntimeError(
      `node-pty at ${source} has no native build for ${process.platform}-${process.arch}`,
    );
  }
  for (const relative of native) {
    copyTree(path.join(source, relative), path.join(destination, relative));
  }
}

function isCompleteRuntime(directory: string): boolean {
  return existsSync(path.join(directory, RUNTIME_MARKER));
}

/**
 * Copies the worker bundle, its shell integration and node-pty into this home, unless a finished
 * copy of the same content is already there. Returns the entry to launch from the copy.
 */
export function prepareTerminalWorkerRuntime(input: {
  paseoHome: string;
  paseoVersion: string;
  bundleDirectory: string;
  nodePtyDirectory: string;
}): TerminalWorkerEntry {
  const root = terminalWorkerDirectory(input.paseoHome);
  ensurePrivateDirectory(root);
  const name = runtimeName(input);
  const directory = path.join(root, name);
  const entry = {
    scriptPath: path.join(directory, TERMINAL_WORKER_BUNDLE_NAME),
    execArgv: [],
    runtime: name,
  };
  if (isCompleteRuntime(directory)) return entry;

  // An interrupted copy left behind: no worker can be running from it.
  rmSync(directory, { recursive: true, force: true });
  const temporary = path.join(root, `${TEMP_PREFIX}${name}-${randomUUID()}`);
  try {
    mkdirSync(temporary, { recursive: true });
    copyTree(
      path.join(input.bundleDirectory, TERMINAL_WORKER_BUNDLE_NAME),
      path.join(temporary, TERMINAL_WORKER_BUNDLE_NAME),
    );
    copyTree(
      path.join(input.bundleDirectory, "shell-integration"),
      path.join(temporary, "shell-integration"),
    );
    copyNodePty(input.nodePtyDirectory, path.join(temporary, "node_modules", "node-pty"));
    writeFileSync(
      path.join(temporary, RUNTIME_MARKER),
      `${JSON.stringify({ paseoVersion: input.paseoVersion, copiedAt: new Date().toISOString() })}\n`,
    );
    renameSync(temporary, directory);
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    if (isCompleteRuntime(directory)) return entry;
    throw new TerminalWorkerRuntimeError(
      `Cannot copy the terminal worker into ${directory}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return entry;
}

export interface PruneTerminalWorkerRuntimesResult {
  removed: string[];
  /** Copies that could not be deleted (a worker that just exited can still hold files on Windows). */
  failed: Array<{ directory: string; error: string }>;
}

/**
 * Deletes every copy no worker record names. With an unreadable record it deletes nothing: that
 * record could name a copy a live worker runs from.
 */
export async function pruneTerminalWorkerRuntimes(
  paseoHome: string,
): Promise<PruneTerminalWorkerRuntimesResult> {
  const result: PruneTerminalWorkerRuntimesResult = { removed: [], failed: [] };
  const root = terminalWorkerDirectory(paseoHome);
  const files = await listTerminalWorkerRecords(paseoHome);
  const inUse = new Set<string>();
  for (const file of files) {
    if ("error" in file) return result;
    if (file.record.runtime) inUse.add(file.record.runtime);
  }
  let names: string[];
  try {
    names = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return result;
    throw error;
  }
  for (const name of names) {
    if (inUse.has(name)) continue;
    const directory = path.join(root, name);
    if (
      !name.startsWith(TEMP_PREFIX) &&
      !(await access(path.join(directory, RUNTIME_MARKER)).then(
        () => true,
        (error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
          throw error;
        },
      ))
    )
      continue;
    try {
      await rm(directory, { recursive: true, force: true });
      result.removed.push(directory);
    } catch (error) {
      result.failed.push({
        directory,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return result;
}
