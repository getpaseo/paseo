import { open, realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { findExecutable } from "../../../../executable-resolution/executable-resolution.js";

const NOT_FOUND_ERROR =
  "OpenCode binary not found. Install OpenCode (https://github.com/opencode-ai/opencode) and ensure it is available in your shell PATH.";

/**
 * Resolve the OpenCode executable Paseo should spawn.
 *
 * npm's `opencode` entry is a Node wrapper that `spawnSync`s the native binary.
 * Killing that wrapper reaps only the Node process; the native server stays
 * behind as an orphan. Spawn the native binary directly so tree-kill tracks it.
 */
export async function resolveOpenCodeBinary(): Promise<string> {
  const found = await findExecutable("opencode");
  if (!found) throw new Error(NOT_FOUND_ERROR);
  return resolveInstalledOpenCodeBinary(found);
}

export async function resolveInstalledOpenCodeBinary(found: string): Promise<string> {
  if (process.platform === "win32" && path.extname(found).toLowerCase() === ".cmd") {
    const windowsBinary = await resolveWindowsOpenCodeBinary(found);
    if (windowsBinary) return windowsBinary;
    console.warn(
      "[opencode-server] Found opencode.cmd but could not resolve the real opencode.exe. " +
        "The process may not be properly terminated on exit. Path: %s",
      found,
    );
    return found;
  }

  if (process.platform !== "win32") {
    const native = await resolvePosixOpenCodeBinary(found);
    if (native) return native;
    if (await hasShebang(found)) warnUnresolvedWrapper(found);
  }

  return found;
}

async function resolveWindowsOpenCodeBinary(found: string): Promise<string | null> {
  const packageDirectories = [
    path.join(path.dirname(found), "node_modules", "opencode-ai"),
    path.join(path.dirname(found), "..", "opencode-ai"),
  ];
  for (const packageDirectory of packageDirectories) {
    const bundledBinary = path.join(packageDirectory, "bin", "opencode.exe");
    if (await pathExists(bundledBinary)) return bundledBinary;

    // Newer npm releases keep the executable in a platform dependency.
    // Resolve from the CLI package so nested installs and pnpm both work.
    try {
      const require = createRequire(path.join(packageDirectory, "package.json"));
      return require.resolve(`opencode-windows-${process.arch}/bin/opencode.exe`);
    } catch {
      // Try the other npm layout before retaining the original command.
    }
  }
  return null;
}

async function resolvePosixOpenCodeBinary(found: string): Promise<string | null> {
  const real = await realpath(found).catch(() => found);
  // The npm wrapper prefers this cached native binary over the platform package.
  const cached = path.join(path.dirname(real), ".opencode");
  if (await pathExists(cached)) return cached;
  // A native `opencode` install has no wrapper. Don't walk its parents looking
  // for an unrelated npm platform package.
  if (!(await hasShebang(real))) return null;
  return findPlatformBinary(path.dirname(real));
}

async function findPlatformBinary(scriptDir: string): Promise<string | null> {
  const binaryName = "opencode";
  let current = scriptDir;
  for (;;) {
    const modules = path.join(current, "node_modules");
    for (const name of platformPackageNames()) {
      const candidate = path.join(modules, name, "bin", binaryName);
      if (await pathExists(candidate)) return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function platformPackageNames(): string[] {
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch;
  const base = `opencode-${platform}-${arch}`;
  if (process.platform === "linux" && arch === "x64") {
    return [base, `${base}-baseline`, `${base}-musl`, `${base}-baseline-musl`];
  }
  if (arch === "x64") return [base, `${base}-baseline`];
  if (process.platform === "linux") return [base, `${base}-musl`];
  return [base];
}

async function hasShebang(filePath: string): Promise<boolean> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, "r");
    const buf = Buffer.alloc(2);
    const { bytesRead } = await handle.read(buf, 0, 2, 0);
    return bytesRead === 2 && buf.toString() === "#!";
  } catch {
    return false;
  } finally {
    await handle?.close();
  }
}

function warnUnresolvedWrapper(found: string): void {
  console.warn(
    "[opencode-server] Found the OpenCode wrapper but could not resolve its native binary. " +
      "The process may not be properly terminated on exit. Path: %s",
    found,
  );
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}
