import { createHash } from "node:crypto";
import { lstatSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensurePrivateDirectory } from "../server/private-files.js";
import { terminalWorkerDirectory } from "./terminal-worker-record.js";

// `sun_path` holds 104 bytes on macOS and 108 on Linux, NUL included. Dev homes under
// worktrees and long $TMPDIR values exceed that, so the socket goes to the first owner-only
// directory whose full path fits, measured in UTF-8 bytes.
const SOCKET_PATH_BYTE_BUDGET: Partial<Record<NodeJS.Platform, number>> = {
  darwin: 103,
  linux: 107,
};
const DEFAULT_SOCKET_PATH_BYTE_BUDGET = 103;
const OWNER_ONLY_MODE = 0o700;

export interface TerminalWorkerSocketPathInput {
  paseoHome: string;
  workerPid: number;
  platform?: NodeJS.Platform;
  tmpDir?: string;
  uid?: number;
}

export interface RejectedSocketCandidate {
  path: string;
  byteLength: number;
  reason: string;
}

export class TerminalWorkerSocketPathError extends Error {
  readonly rejected: RejectedSocketCandidate[];

  constructor(rejected: RejectedSocketCandidate[], budget: number) {
    super(
      [
        `No terminal worker socket path fits ${budget} bytes in an owner-only directory:`,
        ...rejected.map(
          (candidate) => `  ${candidate.path} (${candidate.byteLength} bytes): ${candidate.reason}`,
        ),
      ].join("\n"),
    );
    this.name = "TerminalWorkerSocketPathError";
    this.rejected = rejected;
  }
}

/** First 16 hex chars of sha256(home) plus the worker pid: unique per home and worker. */
export function terminalWorkerSocketId(paseoHome: string, workerPid: number): string {
  const digest = createHash("sha256").update(path.resolve(paseoHome)).digest("hex");
  return `${digest.slice(0, 16)}-${workerPid}`;
}

/**
 * Picks (and creates) the socket path a worker listens on. Windows uses a named pipe; POSIX
 * tries $PASEO_HOME/terminal-worker/sock, then <tmpdir>/paseo-<uid>, then /tmp/paseo-<uid>.
 * A shared root is never chmodded: an existing directory there is used only when it is a real
 * directory owned by this user with mode 0700.
 */
export function resolveTerminalWorkerSocketPath(input: TerminalWorkerSocketPathInput): string {
  const platform = input.platform ?? process.platform;
  const id = terminalWorkerSocketId(input.paseoHome, input.workerPid);
  if (platform === "win32") {
    return `\\\\.\\pipe\\paseo-tw-${id}`;
  }

  const uid = input.uid ?? process.getuid?.() ?? 0;
  const budget = SOCKET_PATH_BYTE_BUDGET[platform] ?? DEFAULT_SOCKET_PATH_BYTE_BUDGET;
  const fileName = `tw-${id}.sock`;
  const homeSocketDirectory = path.join(terminalWorkerDirectory(input.paseoHome), "sock");
  const candidates: Array<{ directory: string; prepare: () => string | null }> = [
    {
      directory: homeSocketDirectory,
      prepare: () => {
        ensurePrivateDirectory(homeSocketDirectory);
        return verifyOwnerOnlyDirectory(homeSocketDirectory, uid);
      },
    },
    ...[input.tmpDir ?? tmpdir(), "/tmp"].map((root) => {
      const directory = path.join(root, `paseo-${uid}`);
      return {
        directory,
        prepare: () => prepareSharedRootDirectory(directory, uid),
      };
    }),
  ];

  const rejected: RejectedSocketCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const socketPath = path.join(candidate.directory, fileName);
    if (seen.has(socketPath)) continue;
    seen.add(socketPath);
    const byteLength = Buffer.byteLength(socketPath, "utf8");
    if (byteLength > budget) {
      rejected.push({ path: socketPath, byteLength, reason: `longer than ${budget} bytes` });
      continue;
    }
    let problem: string | null;
    try {
      problem = candidate.prepare();
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
    }
    if (problem) {
      rejected.push({ path: socketPath, byteLength, reason: problem });
      continue;
    }
    return socketPath;
  }
  throw new TerminalWorkerSocketPathError(rejected, budget);
}

function prepareSharedRootDirectory(directory: string, uid: number): string | null {
  try {
    mkdirSync(directory, { mode: OWNER_ONLY_MODE });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return verifyOwnerOnlyDirectory(directory, uid);
}

/** Returns why the directory cannot hold the socket, or null when it is owner-only. */
function verifyOwnerOnlyDirectory(directory: string, uid: number): string | null {
  const stats = lstatSync(directory);
  if (stats.isSymbolicLink()) return "is a symlink";
  if (!stats.isDirectory()) return "is not a directory";
  if (stats.uid !== uid) return `is owned by uid ${stats.uid}, not ${uid}`;
  const mode = stats.mode & 0o777;
  if (mode !== OWNER_ONLY_MODE) return `has mode ${mode.toString(8)}, not 700`;
  return null;
}
