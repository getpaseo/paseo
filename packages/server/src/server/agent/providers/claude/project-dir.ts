import { existsSync, readdirSync } from "node:fs";
import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Verbatim port of the Claude Agent SDK's project-directory encoding so
// paseo computes the same `~/.claude/projects/<dir>` path the SDK does.
// The SDK ships only as a precompiled bundle; grep the JS source at
// node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs for `function Ar`,
// `function So`, `async function wn`, `function Dy`, `Ni=200`.

const PROJECT_DIR_LENGTH_CAP = 200;

export interface ClaudeProjectDirOptions {
  configDir?: string;
}

export async function claudeProjectDir(
  cwd: string,
  options?: ClaudeProjectDirOptions,
): Promise<string> {
  const canonical = await canonicalize(cwd);
  const projectsRoot = join(resolveConfigDir(options), "projects");
  return resolveProjectDir(projectsRoot, encode(canonical));
}

export function claudeProjectDirSync(cwd: string, options?: ClaudeProjectDirOptions): string {
  const canonical = canonicalizeSync(cwd);
  const projectsRoot = join(resolveConfigDir(options), "projects");
  return resolveProjectDirSync(projectsRoot, encode(canonical));
}

/**
 * On Windows, Claude Code encodes the cwd verbatim, so the encoded folder's drive-letter case
 * depends on which tool launched it (VS Code opens folders with a lowercase drive; paths derived
 * from %USERPROFILE% come out uppercase). paseo canonicalizes the drive letter to uppercase, so an
 * exact-path miss can still be a real match. Fall back to a case-insensitive directory scan — on
 * Windows only, where case-insensitive filesystems make that unambiguous.
 */
function resolveProjectDir(projectsRoot: string, encoded: string): Promise<string> {
  const exact = join(projectsRoot, encoded);
  if (
    process.platform !== "win32" ||
    existsSync(exact) ||
    !existsSync(projectsRoot)
  ) {
    return Promise.resolve(exact);
  }
  const wanted = encoded.toLowerCase();
  try {
    return import("node:fs/promises").then((fs) =>
      fs.readdir(projectsRoot).then((entries) => {
        const match = entries.find((entry) => entry.toLowerCase() === wanted);
        return match ? join(projectsRoot, match) : exact;
      }),
    );
  } catch {
    return Promise.resolve(exact);
  }
}

function resolveProjectDirSync(projectsRoot: string, encoded: string): string {
  const exact = join(projectsRoot, encoded);
  if (process.platform !== "win32" || existsSync(exact) || !existsSync(projectsRoot)) {
    return exact;
  }
  const wanted = encoded.toLowerCase();
  try {
    const match = readdirSync(projectsRoot).find(
      (entry) => entry.toLowerCase() === wanted,
    );
    return match ? join(projectsRoot, match) : exact;
  } catch {
    return exact;
  }
}

async function canonicalize(input: string): Promise<string> {
  try {
    return normalizeProjectPath(await realpath(input));
  } catch {
    return normalizeProjectPath(input);
  }
}

function canonicalizeSync(input: string): string {
  try {
    return normalizeProjectPath(realpathSync.native(input));
  } catch {
    return normalizeProjectPath(input);
  }
}

function normalizeProjectPath(input: string): string {
  return process.platform === "darwin" ? input.normalize("NFC") : input;
}

function encode(input: string): string {
  const replaced = input.replace(/[^a-zA-Z0-9]/g, "-");
  if (replaced.length <= PROJECT_DIR_LENGTH_CAP) {
    return replaced;
  }
  return `${replaced.slice(0, PROJECT_DIR_LENGTH_CAP)}-${hashSuffix(input)}`;
}

function hashSuffix(input: string): string {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function resolveConfigDir(options?: ClaudeProjectDirOptions): string {
  return options?.configDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}
