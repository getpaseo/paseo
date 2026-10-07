import { existsSync, readdirSync, realpathSync } from "node:fs";
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
  return join(projectsRoot, encode(canonical));
}

export function claudeProjectDirSync(cwd: string, options?: ClaudeProjectDirOptions): string {
  const canonical = canonicalizeSync(cwd);
  const projectsRoot = join(resolveConfigDir(options), "projects");
  return join(projectsRoot, encode(canonical));
}

// Claude Code resumes a session by id from any working directory and keeps appending to the
// transcript in the project folder where the session started. That folder differs from the
// one `cwd` encodes to when the project moved, the daemon migrated, or Claude Code sees the
// cwd under another name (a Windows binary under WSL). Returns the expected path when no
// transcript exists anywhere.
export function claudeTranscriptPathSync(input: {
  cwd: string;
  sessionId: string;
  configDir?: string;
}): string {
  const options = { configDir: input.configDir };
  const fileName = `${input.sessionId}.jsonl`;
  const expected = join(claudeProjectDirSync(input.cwd, options), fileName);
  if (existsSync(expected)) {
    return expected;
  }
  const projectsRoot = join(resolveConfigDir(options), "projects");
  let projectDirs: string[];
  try {
    projectDirs = readdirSync(projectsRoot);
  } catch (error) {
    if (isMissingDirectoryError(error)) {
      return expected;
    }
    throw error;
  }
  for (const projectDir of projectDirs) {
    const candidate = join(projectsRoot, projectDir, fileName);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return expected;
}

function isMissingDirectoryError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
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

// Claude Code keeps its settings and transcripts here for a process launched with `env`.
export function claudeConfigDir(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

function resolveConfigDir(options?: ClaudeProjectDirOptions): string {
  return options?.configDir ?? claudeConfigDir(process.env);
}
