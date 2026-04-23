import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

/**
 * Detector for the external Python tooling required by code indexing:
 *   - `code-review-graph` (the main tool)
 *   - `pipx` (preferred installer)
 *   - `python3` (fallback installer + bootstrap)
 *
 * Mirrors the shape of `library/detect-installed.ts`: pure PATH scan with a
 * Windows extension fallback. Pulled out so tests can inject a fake spawn /
 * fake fs without monkey-patching globals.
 */

const MIN_PYTHON_MAJOR = 3;
const MIN_PYTHON_MINOR = 10;

export interface BinaryDetection {
  name: string;
  installed: boolean;
  path?: string;
  version?: string;
  /** Populated for python3: false when version < 3.10 */
  meetsMinimumVersion?: boolean;
}

export interface IndexingToolDetection {
  codeReviewGraph: BinaryDetection;
  pipx: BinaryDetection;
  python3: BinaryDetection;
  /** True when crg can run as-is OR can be installed without further bootstrap. */
  canInstall: boolean;
  /** Suggested install command for the current platform; null when crg already present. */
  suggestedInstall: string | null;
}

export interface DetectorEnv {
  pathDirs: string[];
  pathExts: string[];
  platform: NodeJS.Platform;
  /** Inject for tests; defaults to fs.stat. */
  statFile?: (candidate: string) => Promise<boolean>;
  /** Inject for tests; defaults to spawning the binary with `--version`. */
  versionOf?: (binPath: string) => Promise<string | null>;
}

export function defaultDetectorEnv(): DetectorEnv {
  const pathEnv = process.env.PATH ?? "";
  const pathDirs = pathEnv.split(path.delimiter).filter(Boolean);
  const pathExts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").map((e) => e.toLowerCase())
      : [""];
  return { pathDirs, pathExts, platform: process.platform };
}

export async function findBinary(bin: string, env: DetectorEnv): Promise<string | null> {
  const stat = env.statFile ?? defaultStatFile;
  for (const dir of env.pathDirs) {
    for (const ext of env.pathExts) {
      const candidate = path.join(dir, `${bin}${ext}`);
      if (await stat(candidate)) return candidate;
    }
  }
  return null;
}

async function defaultStatFile(candidate: string): Promise<boolean> {
  try {
    const stat = await fs.stat(candidate);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function defaultVersionOf(binPath: string): Promise<string | null> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(binPath, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      const out = (stdout || stderr).trim();
      resolve(out || null);
    });
  });
}

async function detectBinary(name: string, env: DetectorEnv): Promise<BinaryDetection> {
  const binPath = await findBinary(name, env);
  if (!binPath) return { name, installed: false };
  const versionOf = env.versionOf ?? defaultVersionOf;
  const version = (await versionOf(binPath)) ?? undefined;
  return { name, installed: true, path: binPath, version };
}

export function parsePythonVersion(versionString: string | undefined): {
  major: number;
  minor: number;
  patch: number;
} | null {
  if (!versionString) return null;
  const match = versionString.match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) return null;
  return {
    major: Number.parseInt(match[1] ?? "0", 10),
    minor: Number.parseInt(match[2] ?? "0", 10),
    patch: Number.parseInt(match[3] ?? "0", 10),
  };
}

export function meetsPythonMinimum(versionString: string | undefined): boolean {
  const parsed = parsePythonVersion(versionString);
  if (!parsed) return false;
  if (parsed.major > MIN_PYTHON_MAJOR) return true;
  if (parsed.major < MIN_PYTHON_MAJOR) return false;
  return parsed.minor >= MIN_PYTHON_MINOR;
}

export function suggestedInstallCommand(
  detection: Pick<IndexingToolDetection, "codeReviewGraph" | "pipx" | "python3">,
  platform: NodeJS.Platform,
): string | null {
  if (detection.codeReviewGraph.installed) return null;
  if (detection.pipx.installed) return "pipx install code-review-graph";
  if (detection.python3.installed && detection.python3.meetsMinimumVersion) {
    return "python3 -m pip install --user pipx && pipx install code-review-graph";
  }
  switch (platform) {
    case "darwin":
      return "brew install pipx && pipx install code-review-graph";
    case "win32":
      return "winget install Python.Python.3.12 && pipx install code-review-graph";
    default:
      return "Install Python 3.10+ and pipx, then: pipx install code-review-graph";
  }
}

export async function detectIndexingTools(
  envOverride?: Partial<DetectorEnv>,
): Promise<IndexingToolDetection> {
  const env: DetectorEnv = { ...defaultDetectorEnv(), ...envOverride };
  const [codeReviewGraph, pipx, python3] = await Promise.all([
    detectBinary("code-review-graph", env),
    detectBinary("pipx", env),
    detectBinary("python3", env),
  ]);
  python3.meetsMinimumVersion = meetsPythonMinimum(python3.version);

  const summary = { codeReviewGraph, pipx, python3 };
  const canInstall =
    codeReviewGraph.installed ||
    pipx.installed ||
    (python3.installed && python3.meetsMinimumVersion === true);

  return {
    ...summary,
    canInstall,
    suggestedInstall: suggestedInstallCommand(summary, env.platform),
  };
}
