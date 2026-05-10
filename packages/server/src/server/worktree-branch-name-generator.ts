import { z } from "zod";
import type { FirstAgentContext } from "../shared/messages.js";
import type { AgentManager } from "./agent/agent-manager.js";
import {
  DEFAULT_STRUCTURED_GENERATION_PROVIDERS,
  StructuredAgentFallbackError,
  StructuredAgentResponseError,
  generateStructuredAgentResponseWithFallback,
} from "./agent/agent-response-loop.js";
import { buildAgentBranchNameSeed } from "./agent/prompt-attachments.js";
import { buildMetadataPrompt } from "../utils/build-metadata-prompt.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";

interface BranchNameGeneratorLogger {
  warn: (obj: object, msg?: string) => void;
  error: (obj: object, msg?: string) => void;
}

export interface GenerateBranchNameFromFirstAgentContextOptions {
  agentManager: AgentManager;
  cwd: string;
  workspaceGitService?: Pick<WorkspaceGitService, "resolveRepoRoot">;
  firstAgentContext: FirstAgentContext | undefined;
  logger: BranchNameGeneratorLogger;
  deps?: {
    generateStructuredAgentResponseWithFallback?: typeof generateStructuredAgentResponseWithFallback;
  };
}

const BranchNameSchema = z.object({
  branch: z.string().min(1).max(100),
});

async function buildPrompt(
  seed: string,
  options: {
    cwd: string;
    workspaceGitService?: Pick<WorkspaceGitService, "resolveRepoRoot">;
  },
): Promise<string> {
  return buildMetadataPrompt({
    cwd: options.cwd,
    workspaceGitService: options.workspaceGitService,
    configKey: "branchName",
    before: [
      "Generate a git branch name for a coding agent based on the user prompt and attachments.",
      "Branch: concise lowercase slug using letters, numbers, hyphens, and slashes only.",
      "No spaces, no uppercase, no leading or trailing hyphen, no consecutive hyphens.",
    ].join("\n"),
    after: "Return JSON only with a single field 'branch'.",
    trailing: `User context:\n${seed}`,
  });
}

export async function generateBranchNameFromFirstAgentContext(
  options: GenerateBranchNameFromFirstAgentContextOptions,
): Promise<string | null> {
  const seed = buildAgentBranchNameSeed(options.firstAgentContext);
  if (!seed) {
    return null;
  }

  const generator =
    options.deps?.generateStructuredAgentResponseWithFallback ??
    generateStructuredAgentResponseWithFallback;

  try {
    const result = await generator({
      manager: options.agentManager,
      cwd: options.cwd,
      prompt: await buildPrompt(seed, {
        cwd: options.cwd,
        workspaceGitService: options.workspaceGitService,
      }),
      schema: BranchNameSchema,
      schemaName: "BranchName",
      maxRetries: 2,
      providers: DEFAULT_STRUCTURED_GENERATION_PROVIDERS,
      persistSession: false,
      agentConfigOverrides: {
        title: "Branch name generator",
        internal: true,
      },
    });
    return result.branch.trim() || null;
  } catch (error) {
    if (
      error instanceof StructuredAgentResponseError ||
      error instanceof StructuredAgentFallbackError
    ) {
      options.logger.warn({ err: error }, "Structured branch name generation failed");
      return null;
    }
    options.logger.error({ err: error }, "Branch name generation failed");
    return null;
  }
}
