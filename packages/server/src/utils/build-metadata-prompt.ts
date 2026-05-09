import { readPaseoConfigJson } from "./paseo-config-file.js";
import { PaseoConfigSchema } from "./paseo-config-schema.js";
import { wrapWithUserInstructions } from "./wrap-user-instructions.js";

export type MetadataConfigKey = "agentTitle" | "branchName" | "commitMessage" | "pullRequest";

export interface RepoRootResolver {
  resolveRepoRoot: (cwd: string) => Promise<string>;
}

export interface BuildMetadataPromptOptions {
  cwd: string;
  configKey: MetadataConfigKey;
  before: string;
  after: string;
  trailing?: string;
  workspaceGitService?: RepoRootResolver;
}

export async function buildMetadataPrompt(options: BuildMetadataPromptOptions): Promise<string> {
  const instructions = await readProjectMetadataInstructions(options);
  const head = isNonEmptyString(instructions)
    ? wrapWithUserInstructions(options.before, instructions, options.after)
    : `${options.before}\n${options.after}`;
  return options.trailing ? `${head}\n\n${options.trailing}` : head;
}

async function readProjectMetadataInstructions(
  options: Pick<BuildMetadataPromptOptions, "cwd" | "configKey" | "workspaceGitService">,
): Promise<string | undefined> {
  if (!options.workspaceGitService) {
    return undefined;
  }
  try {
    const repoRoot = await options.workspaceGitService.resolveRepoRoot(options.cwd);
    const json = readPaseoConfigJson(repoRoot);
    const config = PaseoConfigSchema.parse(json);
    return config.metadataGeneration?.[options.configKey]?.instructions;
  } catch {
    return undefined;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}
