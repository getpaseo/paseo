import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Verbatim port of the Claude Agent SDK's project-directory encoding so
// paseo computes the same `~/.claude/projects/<dir>` path the SDK does.
// The SDK ships only as a precompiled bundle; grep the JS source at
// node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs for `function f1`,
// `function i4`, `function tB`, `S0=200`.

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

async function canonicalize(input: string): Promise<string> {
  try {
    return (await realpath(input)).normalize("NFC");
  } catch {
    return input.normalize("NFC");
  }
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
