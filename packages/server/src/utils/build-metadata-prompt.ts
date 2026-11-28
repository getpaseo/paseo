import { readPaseoConfig } from "./paseo-config-file.js";
import { type PaseoMetadataGeneration } from "@getpaseo/protocol/paseo-config-schema";

export type MetadataConfigKey = "title" | "branchName" | "commitMessage" | "pullRequest";

export interface RepoRootResolver {
  resolveRepoRoot: (cwd: string) => Promise<string>;
}

// A style section carries the default guidance for one artifact. The project
// owner replaces it wholesale via paseo.json metadataGeneration.<configKey>.instructions
// — their text is used instead of the default, never appended alongside it, so the
// two never conflict. The contract block (what to produce, the JSON shape, and any
// correctness/safety rules) lives outside the sections and is never overridable.
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
  hostInstructions?: string;
  workspaceGitService?: RepoRootResolver;
}

export async function buildMetadataPrompt(options: BuildMetadataPromptOptions): Promise<string> {
  const overrides = await readProjectMetadataOverrides(options);
  let hasProjectOverride = false;
  const styleBlocks = options.styles.map((section) => {
    const override = overrides?.[section.configKey]?.instructions;
    if (isNonEmptyString(override)) {
      hasProjectOverride = true;
    }
    return renderStyleSection(section, override);
  });
  const hostBlock = renderHostInstructions(options.hostInstructions, hasProjectOverride);
  const head = [
    options.contract,
    ...styleBlocks,
    ...(hostBlock ? [hostBlock] : []),
    options.after,
  ].join("\n\n");
  return options.trailing ? `${head}\n\n${options.trailing}` : head;
}

function renderStyleSection(section: MetadataStyleSection, override: string | undefined): string {
  const body = isNonEmptyString(override) ? override.trim() : section.default;
  return section.label ? `${section.label}:\n${body}` : body;
}

function renderHostInstructions(
  hostInstructions: string | undefined,
  hasProjectOverride: boolean,
): string | null {
  if (!isNonEmptyString(hostInstructions)) {
    return null;
  }
  const label = hasProjectOverride
    ? "Additional host instructions (follow these too, unless the style above says otherwise)"
    : "Additional instructions";
  return `${label}:\n${hostInstructions.trim()}`;
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
