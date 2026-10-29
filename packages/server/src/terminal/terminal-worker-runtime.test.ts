import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isPlatform } from "../test-utils/platform.js";
import {
  prepareTerminalWorkerRuntime,
  pruneTerminalWorkerRuntimes,
  TerminalWorkerRuntimeError,
} from "./terminal-worker-runtime.js";
import {
  terminalWorkerDirectory,
  writeTerminalWorkerRecord,
  type TerminalWorkerRecord,
} from "./terminal-worker-record.js";

const temporaryDirs: string[] = [];

afterEach(() => {
  for (const dir of temporaryDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  temporaryDirs.push(dir);
  return dir;
}

// A built bundle directory and a node-pty package shaped like the real ones.
function makeSources(bundleSource = "export {};\n"): {
  bundleDirectory: string;
  nodePtyDirectory: string;
} {
  const bundleDirectory = makeDir("tw-bundle-");
  writeFileSync(path.join(bundleDirectory, "terminal-worker.mjs"), bundleSource);
  mkdirSync(path.join(bundleDirectory, "shell-integration", "zsh"), { recursive: true });
  writeFileSync(path.join(bundleDirectory, "shell-integration", "zsh", ".zshenv"), "# zsh\n");
  const nodePtyDirectory = makeDir("tw-node-pty-");
  writeFileSync(path.join(nodePtyDirectory, "package.json"), '{"version":"1.2.3"}\n');
  mkdirSync(path.join(nodePtyDirectory, "lib"));
  writeFileSync(path.join(nodePtyDirectory, "lib", "index.js"), "module.exports = {};\n");
  const native = path.join(nodePtyDirectory, "prebuilds", `${process.platform}-${process.arch}`);
  mkdirSync(native, { recursive: true });
  writeFileSync(path.join(native, "pty.node"), "native");
  writeFileSync(path.join(native, "spawn-helper"), "#!/bin/sh\n", { mode: 0o755 });
  // Another platform's build is not copied.
  mkdirSync(path.join(nodePtyDirectory, "prebuilds", "other-platform"));
  return { bundleDirectory, nodePtyDirectory };
}

function recordNaming(runtime: string | null, pid = 4242): TerminalWorkerRecord {
  return {
    recordId: `record-${pid}`,
    pid,
    bootId: null,
    createdAt: new Date().toISOString(),
    identity: { startedAt: "Thu Jan  1 00:00:00 1970", commandLine: "worker" },
    protocolVersion: 1,
    paseoVersion: "1.0.0",
    socketPath: "/tmp/does-not-exist.sock",
    secret: "secret",
    runtime,
    terminals: [],
  };
}

describe("terminal worker runtime copy", () => {
  it("copies the bundle, its shell integration and this platform's node-pty into the home", () => {
    const home = makeDir("tw-runtime-home-");
    const entry = prepareTerminalWorkerRuntime({
      paseoHome: home,
      paseoVersion: "1.0.0-beta.1",
      ...makeSources(),
    });

    const directory = path.join(terminalWorkerDirectory(home), entry.runtime!);
    expect(entry.runtime).toMatch(/^1\.0\.0-beta\.1-[0-9a-f]{12}$/);
    expect(entry.scriptPath).toBe(path.join(directory, "terminal-worker.mjs"));
    expect(entry.execArgv).toEqual([]);
    expect(existsSync(path.join(directory, "shell-integration", "zsh", ".zshenv"))).toBe(true);
    const nodePty = path.join(directory, "node_modules", "node-pty");
    expect(existsSync(path.join(nodePty, "lib", "index.js"))).toBe(true);
    expect(readdirSync(path.join(nodePty, "prebuilds"))).toEqual([
      `${process.platform}-${process.arch}`,
    ]);
    if (!isPlatform("win32")) {
      const helper = path.join(nodePty, "prebuilds", `${process.platform}-${process.arch}`);
      expect(statSync(path.join(helper, "spawn-helper")).mode & 0o111).toBe(0o111);
    }
  });

  it("reuses a finished copy of the same content and makes a new one for a different build", () => {
    const home = makeDir("tw-runtime-home-");
    const sources = makeSources();
    const first = prepareTerminalWorkerRuntime({
      paseoHome: home,
      paseoVersion: "1.0.0",
      ...sources,
    });
    const marker = path.join(terminalWorkerDirectory(home), first.runtime!, "terminal-worker.mjs");
    writeFileSync(marker, "// the running copy\n");

    const again = prepareTerminalWorkerRuntime({
      paseoHome: home,
      paseoVersion: "1.0.0",
      ...sources,
    });
    const rebuilt = prepareTerminalWorkerRuntime({
      paseoHome: home,
      paseoVersion: "1.0.0",
      ...makeSources("export const rebuilt = true;\n"),
    });

    expect(again.runtime).toBe(first.runtime);
    expect(statSync(marker).size).toBe("// the running copy\n".length);
    expect(rebuilt.runtime).not.toBe(first.runtime);
  });

  it("replaces a copy an earlier run left unfinished", () => {
    const home = makeDir("tw-runtime-home-");
    const sources = makeSources();
    const first = prepareTerminalWorkerRuntime({
      paseoHome: home,
      paseoVersion: "1.0.0",
      ...sources,
    });
    const directory = path.join(terminalWorkerDirectory(home), first.runtime!);
    rmSync(directory, { recursive: true });
    mkdirSync(directory);

    prepareTerminalWorkerRuntime({ paseoHome: home, paseoVersion: "1.0.0", ...sources });

    expect(existsSync(path.join(directory, "terminal-worker.mjs"))).toBe(true);
  });

  it("fails before copying anything when node-pty has no native build for this platform", () => {
    const home = makeDir("tw-runtime-home-");
    const sources = makeSources();
    rmSync(path.join(sources.nodePtyDirectory, "prebuilds"), { recursive: true });

    expect(() =>
      prepareTerminalWorkerRuntime({ paseoHome: home, paseoVersion: "1.0.0", ...sources }),
    ).toThrow(TerminalWorkerRuntimeError);
    expect(readdirSync(terminalWorkerDirectory(home))).toEqual([]);
  });

  it("removes only copies no worker record names", async () => {
    const home = makeDir("tw-runtime-home-");
    const used = prepareTerminalWorkerRuntime({
      paseoHome: home,
      paseoVersion: "1.0.0",
      ...makeSources(),
    });
    const unused = prepareTerminalWorkerRuntime({
      paseoHome: home,
      paseoVersion: "0.9.0",
      ...makeSources(),
    });
    writeTerminalWorkerRecord(home, recordNaming(used.runtime));
    const socketDirectory = path.join(terminalWorkerDirectory(home), "sock");
    mkdirSync(socketDirectory);

    const result = await pruneTerminalWorkerRuntimes(home);

    expect(result.removed).toEqual([path.join(terminalWorkerDirectory(home), unused.runtime!)]);
    expect(existsSync(path.dirname(used.scriptPath))).toBe(true);
    expect(existsSync(socketDirectory)).toBe(true);
  });

  it("removes nothing while a record cannot be read", async () => {
    const home = makeDir("tw-runtime-home-");
    const copy = prepareTerminalWorkerRuntime({
      paseoHome: home,
      paseoVersion: "1.0.0",
      ...makeSources(),
    });
    writeFileSync(path.join(terminalWorkerDirectory(home), "4242.json"), "{ not json");

    expect((await pruneTerminalWorkerRuntimes(home)).removed).toEqual([]);
    expect(existsSync(copy.scriptPath)).toBe(true);
  });
});

describe("terminal worker bundle", () => {
  // The copy holds the bundle and node-pty only. A package the bundle loads at run time
  // (a require hidden from esbuild behind createRequire) would be missing from it.
  it("loads nothing at run time but Node built-ins and node-pty", async () => {
    const outDir = makeDir("tw-bundle-build-");
    const script = fileURLToPath(
      new URL("../../scripts/build-terminal-worker.mjs", import.meta.url),
    );
    const { buildTerminalWorkerBundle } = (await import(script)) as {
      buildTerminalWorkerBundle(input: { outDir: string }): Promise<void>;
    };
    await buildTerminalWorkerBundle({ outDir });

    const bundle = readFileSync(path.join(outDir, "terminal-worker.mjs"), "utf8");
    const loaded = new Set<string>();
    for (const match of bundle.matchAll(
      /(?:\brequire\w*(?:\.resolve)?\(|\bfrom\s+|\bimport\s*\()\s*"([^"]+)"/g,
    )) {
      loaded.add(match[1]!);
    }
    const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
    const packages = [...loaded].filter((specifier) => !builtins.has(specifier));
    expect(packages.map((specifier) => specifier.split("/")[0])).toEqual(
      packages.map(() => "node-pty"),
    );
    expect(existsSync(path.join(outDir, "shell-integration", "zsh"))).toBe(true);
  });
});
