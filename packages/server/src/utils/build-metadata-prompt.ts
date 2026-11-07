import { readPaseoConfig } from "./paseo-config-file.js";
import {
  type PaseoMetadataGeneration,
  type PaseoMetadataGenerationInstructions,
} from "@getpaseo/protocol/paseo-config-schema";

export type MetadataConfigKey = "title" | "branchName" | "commitMessage" | "pullRequest";

export interface RepoRootResolver {
  resolveRepoRoot: (cwd: string) => Promise<string>;
}

// A style section carries the default guidance for one artifact. Two owners can
// replace it wholesale: the project via paseo.json metadataGeneration.<configKey>
// .instructions, and the host via the same key under agents.metadataGeneration in
// ~/.paseo/config.json. Project instructions win, host instructions are the
// fallback, and either replaces the default instead of being appended to it, so
// the sources never conflict. The contract block (what to produce, the JSON shape,
// and any correctness/safety rules) lives outside the sections and is never
// overridable.
export interface MetadataStyleSection {
  configKey: MetadataConfigKey;
  default: string;
  label?: string;
}

export interface BuildMetadataPromptOptions {
  cwd: string;
  contract: string;
  styles: MetadataStyleSection[];
  after: string;
  trailing?: string;
  workspaceGitService?: RepoRootResolver;
  /** Host-wide wording defaults, used when the project does not set that type. */
  globalInstructions?: PaseoMetadataGenerationInstructions | null;
}

export async function buildMetadataPrompt(options: BuildMetadataPromptOptions): Promise<string> {
  const overrides = await readProjectMetadataOverrides(options);
  const styleBlocks = options.styles.map((section) =>
    renderStyleSection(section, resolveInstructions(section.configKey, overrides, options)),
  );
  const head = [options.contract, ...styleBlocks, options.after].join("\n\n");
  return options.trailing ? `${head}\n\n${options.trailing}` : head;
}

function resolveInstructions(
  configKey: MetadataConfigKey,
  projectOverrides: PaseoMetadataGeneration | undefined,
  options: Pick<BuildMetadataPromptOptions, "globalInstructions">,
): string | undefined {
  const project = projectOverrides?.[configKey]?.instructions;
  if (isNonEmptyString(project)) {
    return project;
  }
  const global = options.globalInstructions?.[configKey]?.instructions;
  return isNonEmptyString(global) ? global : undefined;
}

function renderStyleSection(section: MetadataStyleSection, override: string | undefined): string {
  const body = isNonEmptyString(override) ? override.trim() : section.default;
  return section.label ? `${section.label}:\n${body}` : body;
}

async function readProjectMetadataOverrides(
  options: Pick<BuildMetadataPromptOptions, "cwd" | "workspaceGitService">,
): Promise<PaseoMetadataGeneration | undefined> {
  if (!options.workspaceGitService) {
    return undefined;
  }
  try {
    const repoRoot = await options.workspaceGitService.resolveRepoRoot(options.cwd);
    const result = await readPaseoConfig(repoRoot);
    return result.ok ? result.config?.metadataGeneration : undefined;
  } catch {
    return undefined;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}
