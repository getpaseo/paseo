import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { ToolPermissionRuleSchema, type ToolPermissionRule } from "./agent-permissions.js";

const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024;
const PARTIAL_PATTERN = /!\{\{\s*([^}]+?)\s*\}\}/g;

const AgentDefinitionFrontmatterSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    prompt: z.enum(["extend", "override"]).default("extend"),
    mcp: z.array(z.string().min(1)).optional(),
    model: z.string().min(1).optional(),
    tools: z.array(z.string().min(1)).optional(),
    permissions: z.array(ToolPermissionRuleSchema).optional(),
    // Parsed for the future explicit project-context model. It is intentionally
    // inactive here; Paseo Agent still keeps implicit AGENTS.md discovery off.
    projectContext: z.boolean().optional(),
  })
  .passthrough();

export type AgentDefinitionFrontmatter = z.infer<typeof AgentDefinitionFrontmatterSchema>;
export type PromptProfileFrontmatter = AgentDefinitionFrontmatter;

export interface PaseoComposedPrompt {
  customPrompt?: string;
  appendSystemPrompt: string[];
}

export interface ResolvedAgentDefinition {
  id: string;
  path: string;
  frontmatter: AgentDefinitionFrontmatter;
  body: string;
  composedPrompt: PaseoComposedPrompt;
  expectedMcpServers: string[];
  model?: string;
  tools?: string[];
  permissions: ToolPermissionRule[];
}

export type ResolvedPromptProfile = ResolvedAgentDefinition;

interface LoadAgentDefinitionOptions {
  maxDepth?: number;
  maxTotalBytes?: number;
}

interface LoadState {
  totalBytes: number;
}

interface ParsedMarkdown {
  frontmatter: AgentDefinitionFrontmatter;
  body: string;
}

export function loadAgentDefinition(
  paseoHome: string,
  agentName: string | undefined,
  options: LoadAgentDefinitionOptions = {},
): ResolvedAgentDefinition | null {
  if (!agentName) {
    return null;
  }

  const agentsDir = resolve(paseoHome, "agents");
  const agentPath = resolveAgentPath(agentsDir, agentName);
  if (!existsSync(agentPath)) {
    return null;
  }

  const state: LoadState = { totalBytes: 0 };
  const parsed = loadMarkdownWithPartials({
    agentsDir,
    path: agentPath,
    depth: 0,
    stack: [],
    state,
    options,
    allowFrontmatter: true,
  });
  const body = trimPrompt(parsed.body);
  const promptMode = parsed.frontmatter.prompt;
  const composedPrompt =
    promptMode === "override"
      ? { customPrompt: body, appendSystemPrompt: [] }
      : { appendSystemPrompt: body ? [body] : [] };

  return {
    id: basename(agentPath, ".md"),
    path: agentPath,
    frontmatter: parsed.frontmatter,
    body,
    composedPrompt,
    expectedMcpServers: parsed.frontmatter.mcp ?? [],
    ...(parsed.frontmatter.model ? { model: parsed.frontmatter.model } : {}),
    ...(parsed.frontmatter.tools ? { tools: parsed.frontmatter.tools } : {}),
    permissions: parsed.frontmatter.permissions ?? [],
  };
}

export function loadPromptProfile(
  paseoHome: string,
  profileName: string | undefined,
  options: LoadAgentDefinitionOptions = {},
): ResolvedPromptProfile | null {
  return loadAgentDefinition(paseoHome, profileName, options);
}

export function listAgentDefinitionIds(paseoHome: string): string[] {
  const agentsDir = resolve(paseoHome, "agents");
  if (!existsSync(agentsDir)) {
    return [];
  }
  return readdirSync(agentsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && extname(entry.name) === ".md")
    .map((entry) => basename(entry.name, ".md"))
    .sort();
}

export function listPromptProfileIds(paseoHome: string): string[] {
  return listAgentDefinitionIds(paseoHome);
}

function resolveAgentPath(agentsDir: string, agentName: string): string {
  if (!isSafeRelativePath(agentName) || agentName.includes("/") || agentName.includes("\\")) {
    throw new Error(`Invalid Paseo Agent definition path: ${agentName}`);
  }
  const filename = agentName.endsWith(".md") ? agentName : `${agentName}.md`;
  return resolveConfinedPath(agentsDir, filename);
}

function resolvePartialPath(agentsDir: string, currentPath: string, partialPath: string): string {
  if (!isSafeRelativePath(partialPath)) {
    throw new Error(`Invalid Paseo Agent partial path: ${partialPath}`);
  }
  return resolveConfinedPath(agentsDir, resolve(dirname(currentPath), partialPath));
}

function isSafeRelativePath(input: string): boolean {
  return input.trim() === input && input.length > 0 && !isAbsolute(input) && !input.includes("\0");
}

function resolveConfinedPath(agentsDir: string, input: string): string {
  const realAgentsDir = existsSync(agentsDir) ? realpathSync(agentsDir) : agentsDir;
  const resolved = isAbsolute(input) ? input : resolve(agentsDir, input);
  const comparablePath = existsSync(resolved) ? realpathSync(resolved) : resolved;
  const rel = relative(realAgentsDir, comparablePath);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Paseo Agent path escapes agents directory: ${input}`);
  }
  return resolved;
}

function loadMarkdownWithPartials(input: {
  agentsDir: string;
  path: string;
  depth: number;
  stack: string[];
  state: LoadState;
  options: LoadAgentDefinitionOptions;
  allowFrontmatter: boolean;
}): ParsedMarkdown {
  const maxDepth = input.options.maxDepth ?? DEFAULT_MAX_DEPTH;
  if (input.depth > maxDepth) {
    throw new Error(`Paseo Agent prompt include depth exceeds ${maxDepth}`);
  }
  if (!existsSync(input.path) || !statSync(input.path).isFile()) {
    throw new Error(`Paseo Agent partial not found: ${relative(input.agentsDir, input.path)}`);
  }

  const path = realpathConfined(input.agentsDir, input.path);
  if (input.stack.includes(path)) {
    const cycle = [...input.stack, path].map((entry) => relative(input.agentsDir, entry));
    throw new Error(`Paseo Agent partial cycle: ${cycle.join(" -> ")}`);
  }

  const raw = readFileSync(path, "utf8");
  input.state.totalBytes += Buffer.byteLength(raw, "utf8");
  const maxTotalBytes = input.options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  if (input.state.totalBytes > maxTotalBytes) {
    throw new Error(`Paseo Agent definition exceeds ${maxTotalBytes} bytes`);
  }

  const parsed = parseMarkdown(raw, input.allowFrontmatter);
  const stack = [...input.stack, path];
  const bodyWithPartials = parsed.body.replace(
    PARTIAL_PATTERN,
    (_match, partialPath: string) =>
      loadMarkdownWithPartials({
        ...input,
        path: resolvePartialPath(input.agentsDir, path, partialPath.trim()),
        depth: input.depth + 1,
        stack,
        allowFrontmatter: false,
      }).body,
  );

  return {
    frontmatter: parsed.frontmatter,
    body: bodyWithPartials,
  };
}

function realpathConfined(agentsDir: string, path: string): string {
  const realAgentsDir = realpathSync(agentsDir);
  const realPath = realpathSync(path);
  const rel = relative(realAgentsDir, realPath);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`Paseo Agent path escapes agents directory: ${relative(agentsDir, path)}`);
  }
  return realPath;
}

function parseMarkdown(raw: string, allowFrontmatter: boolean): ParsedMarkdown {
  if (!raw.startsWith("---\n") && !raw.startsWith("---\r\n")) {
    return {
      frontmatter: AgentDefinitionFrontmatterSchema.parse({}),
      body: raw,
    };
  }

  if (!allowFrontmatter) {
    throw new Error("Paseo Agent partials cannot declare frontmatter");
  }

  const newline = raw.startsWith("---\r\n") ? "\r\n" : "\n";
  const closeMarker = `${newline}---${newline}`;
  const closeIndex = raw.indexOf(closeMarker, 4);
  if (closeIndex === -1) {
    throw new Error("Paseo Agent definition has unterminated frontmatter");
  }

  const yaml = raw.slice(4, closeIndex);
  const body = raw.slice(closeIndex + closeMarker.length);
  const value = yaml.trim() ? parseYaml(yaml) : {};
  return {
    frontmatter: AgentDefinitionFrontmatterSchema.parse(value ?? {}),
    body,
  };
}

export function composePromptParts(input: {
  agent?: ResolvedAgentDefinition | null;
  systemPrompt?: string;
  daemonAppendSystemPrompt?: string;
}): PaseoComposedPrompt | undefined {
  const agentPrompt = input.agent?.composedPrompt;
  const appendSystemPrompt = [
    ...(agentPrompt?.appendSystemPrompt ?? []),
    input.systemPrompt,
    input.daemonAppendSystemPrompt,
  ].flatMap((part) => {
    const trimmed = trimPrompt(part);
    return trimmed ? [trimmed] : [];
  });
  const hasCustomPrompt = Boolean(
    agentPrompt && Object.prototype.hasOwnProperty.call(agentPrompt, "customPrompt"),
  );
  const customPrompt = trimPrompt(agentPrompt?.customPrompt);

  if (!hasCustomPrompt && appendSystemPrompt.length === 0) {
    return undefined;
  }

  return {
    ...(hasCustomPrompt ? { customPrompt } : {}),
    appendSystemPrompt,
  };
}

function trimPrompt(value: string | undefined): string {
  return value?.trim() ?? "";
}
