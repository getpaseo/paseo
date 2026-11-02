import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve as resolvePath } from "node:path";

// Where the Paseo CLI lives, for the PATH entry and PASEO_HOOK_CLI every terminal gets. Kept
// apart from terminal.ts so the daemon can resolve it without loading node-pty.

const require = createRequire(import.meta.url);
const PASEO_CLI_BIN_ENTRY = "@getpaseo/cli/bin/paseo";

export function resolveExternalProcessPath(filePath: string): string {
  return filePath.replace(/\.asar(?=[/\\]|$)/, ".asar.unpacked");
}

export function resolvePaseoCliBinDir(): string | null {
  const cliExecutable = resolvePaseoCliExecutablePath();
  return cliExecutable ? dirname(cliExecutable) : null;
}

export function resolvePaseoCliExecutablePath(): string | null {
  const configuredCli = process.env.PASEO_CLI?.trim();
  if (configuredCli) {
    return resolvePath(configuredCli);
  }

  const cliEntrypoint = resolvePaseoCliBinEntrypoint();
  if (!cliEntrypoint) {
    return null;
  }

  const externalCliEntrypoint = resolveExternalProcessPath(cliEntrypoint);
  const npmBinDir = findNpmBinDir(dirname(externalCliEntrypoint));
  if (npmBinDir) {
    const shim = resolvePaseoCliShim(npmBinDir);
    if (shim) {
      return shim;
    }
  }

  return externalCliEntrypoint;
}

function resolvePaseoCliBinEntrypoint(): string | null {
  try {
    return require.resolve(PASEO_CLI_BIN_ENTRY);
  } catch {
    return null;
  }
}

function findNpmBinDir(startPath: string): string | null {
  let current = startPath;
  while (true) {
    const candidate = join(current, "node_modules", ".bin");
    if (hasPaseoCliShim(candidate)) {
      return candidate;
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function hasPaseoCliShim(binDir: string): boolean {
  return resolvePaseoCliShim(binDir) !== null;
}

function resolvePaseoCliShim(binDir: string): string | null {
  for (const name of paseoCliShimNames()) {
    const candidate = join(binDir, name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function paseoCliShimNames(): string[] {
  return process.platform === "win32" ? ["paseo.cmd", "paseo.exe", "paseo"] : ["paseo"];
}
