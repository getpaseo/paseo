import { readdirSync } from "node:fs";
import { extname, join } from "node:path";

interface WindowsFindExecutableOptions {
  enumeratePathCandidates: (name: string) => Promise<string[]>;
  probeExecutable: (
    executablePath: string,
    options: { probeTimeoutMs: number; signal?: AbortSignal },
  ) => Promise<boolean>;
  exists: (path: string) => boolean;
  localAppData?: string;
  probeTimeoutMs: number;
  signal?: AbortSignal;
}

interface WindowsExecutableExistsOptions {
  exists: (path: string) => boolean;
}

function hasPathSeparator(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

function enumerateLiteralPathCandidates(executablePath: string): string[] {
  if (extname(executablePath)) {
    return [executablePath];
  }
  return [executablePath, `${executablePath}.exe`, `${executablePath}.cmd`];
}

function enumerateWingetPackageCandidates(
  name: string,
  localAppData: string | undefined,
): string[] {
  if (!localAppData) {
    return [];
  }

  const wingetPackages = join(localAppData, "Microsoft", "WinGet", "Packages");
  let packageDirs: string[];
  try {
    packageDirs = readdirSync(wingetPackages, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  const exeName = `${name}.exe`;
  return packageDirs.map((packageDir) => join(wingetPackages, packageDir, exeName));
}

async function find(input: string, options: WindowsFindExecutableOptions): Promise<string | null> {
  options.signal?.throwIfAborted();
  if (hasPathSeparator(input)) {
    return findFirstProbeable(enumerateLiteralPathCandidates(input), options);
  }

  const pathCandidates = await options.enumeratePathCandidates(input);
  options.signal?.throwIfAborted();
  const wingetCandidates = enumerateWingetPackageCandidates(
    input,
    options.localAppData ?? process.env.LOCALAPPDATA,
  ).filter(options.exists);

  return findFirstProbeable([...pathCandidates, ...wingetCandidates], options);
}

async function findFirstProbeable(
  candidates: string[],
  options: WindowsFindExecutableOptions,
): Promise<string | null> {
  const seen = new Set<string>();
  for (const candidate of candidates) {
    options.signal?.throwIfAborted();
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);
    if (!options.exists(candidate)) {
      continue;
    }
    if (
      await options.probeExecutable(candidate, {
        probeTimeoutMs: options.probeTimeoutMs,
        signal: options.signal,
      })
    ) {
      return candidate;
    }
  }
  return null;
}

function exists(executablePath: string, options: WindowsExecutableExistsOptions): string | null {
  for (const candidate of enumerateLiteralPathCandidates(executablePath)) {
    if (options.exists(candidate)) {
      return candidate;
    }
  }
  return null;
}

export const windowsExecutableResolution = {
  exists,
  find,
};
