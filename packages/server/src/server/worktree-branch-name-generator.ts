import { z } from "zod";
import type { FirstAgentContext } from "@getpaseo/protocol/messages";
import type { AgentManager } from "./agent/agent-manager.js";
import {
  StructuredAgentFallbackError,
  StructuredAgentResponseError,
  generateStructuredAgentResponseWithFallback,
} from "./agent/agent-response-loop.js";
import {
  resolveStructuredGenerationProviders,
  type StructuredGenerationDaemonConfig,
} from "./agent/structured-generation-providers.js";
import { buildAgentBranchNameSeed } from "./agent/prompt-attachments.js";
import { buildMetadataPrompt } from "../utils/build-metadata-prompt.js";
import type { WorkspaceGitService } from "./workspace-git-service.js";
import type { ProviderSnapshotManager } from "./agent/provider-snapshot-manager.js";

interface BranchNameGeneratorLogger {
  info: (obj: object, msg?: string) => void;
  warn: (obj: object, msg?: string) => void;
  error: (obj: object, msg?: string) => void;
}

export interface GenerateBranchNameFromFirstAgentContextOptions {
  agentManager: AgentManager;
  cwd: string;
  workspaceGitService?: Pick<WorkspaceGitService, "resolveRepoRoot">;
  providerSnapshotManager?: Pick<ProviderSnapshotManager, "listProviders">;
  daemonConfig?: StructuredGenerationDaemonConfig | null;
  currentSelection?: {
    provider?: string | null;
    model?: string | null;
    thinkingOptionId?: string | null;
  };
  firstAgentContext: FirstAgentContext | undefined;
  logger: BranchNameGeneratorLogger;
  deps?: {
    generateStructuredAgentResponseWithFallback?: typeof generateStructuredAgentResponseWithFallback;
  };
}

const BranchNameSchema = z.object({
  title: z.string().min(1).max(80),
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
    contract: [
      "Generate a title and a git branch name for a coding agent from the user prompt and attachments.",
      "The branch must be a valid git ref: lowercase letters, numbers, hyphens, and slashes only, with no spaces, no uppercase, no leading or trailing hyphen, and no consecutive hyphens.",
      "The branch is generated directly from the prompt — it is NEVER derived from or slugified from the title.",
    ].join("\n"),
    styles: [
      {
        configKey: "title",
        label: "Title style",
        default: [
          "A terse, task-shaped label naming what the task is about (sentence case, max 80 characters).",
          "Aim for about 4 words. Go longer only when the task genuinely needs it; most titles must stay short.",
          "Do not start with a generic 'do' verb (Fix, Add, Implement, Diagnose, Update, Change, Create, Set, Make) — every task is implicitly one of these, so the verb is noise. Name the thing instead.",
          "Keep a verb only when it states the specific operation (Swap, Split, Extract, Rename, Merge, Inline).",
          'Good titles: "Swap sidebar history icon", "Composer keyboard shift", "Agent auto-titling", "Worktree selection memory", "Split browser pane".',
          'Bad titles: "Fix composer pushed up by keyboard in workspace", "Diagnose auto-titling still happening for agents", "Change sidebar history icon from clock to history icon".',
        ].join("\n"),
      },
      {
        configKey: "branchName",
        label: "Branch style",
        default: "A short, descriptive slug — a few lowercase words joined by hyphens.",
      },
    ],
    after: "Return JSON only with fields 'title' and 'branch'.",
    trailing: `User context:\n${seed}`,
  });
}

export interface GeneratedWorkspaceName {
  title: string | null;
  branch: string | null;
}

export async function generateBranchNameFromFirstAgentContext(
  options: GenerateBranchNameFromFirstAgentContextOptions,
): Promise<GeneratedWorkspaceName | null> {
  const seed = buildAgentBranchNameSeed(options.firstAgentContext);
  if (!seed) {
    return null;
  }

  const generator =
    options.deps?.generateStructuredAgentResponseWithFallback ??
    generateStructuredAgentResponseWithFallback;

  try {
    const providers = options.providerSnapshotManager
      ? await resolveStructuredGenerationProviders({
          cwd: options.cwd,
          providerSnapshotManager: options.providerSnapshotManager,
          daemonConfig: options.daemonConfig,
          currentSelection: options.currentSelection,
        })
      : [];
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
      providers,
      persistSession: false,
      logger: options.logger,
      agentConfigOverrides: {
        title: "Branch name generator",
        internal: true,
      },
    });
    return {
      title: result.title.trim() || null,
      branch: result.branch.trim() || null,
    };
  } catch (error) {
    const attempts = error instanceof StructuredAgentFallbackError ? error.attempts : undefined;
    options.logger.error(
      { err: error, attempts },
      error instanceof StructuredAgentResponseError || error instanceof StructuredAgentFallbackError
        ? "Structured branch name generation failed"
        : "Branch name generation failed",
    );
    return null;
  }
}
