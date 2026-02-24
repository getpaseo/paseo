import { basename } from "path";
import { z } from "zod";
import type { Logger } from "pino";

import type { AgentManager } from "./agent-manager.js";
import {
  DEFAULT_STRUCTURED_GENERATION_PROVIDERS,
  StructuredAgentFallbackError,
  StructuredAgentResponseError,
  generateStructuredAgentResponseWithFallback,
} from "./agent-response-loop.js";
import { validateBranchSlug } from "../../utils/worktree.js";
import {
  getCheckoutStatus,
  renameCurrentBranch,
  type CheckoutStatusResult,
} from "../../utils/checkout-git.js";
import { MAX_AUTO_AGENT_TITLE_CHARS } from "./agent-title-limits.js";

export type AgentMetadataGeneratorDeps = {
  generateStructuredAgentResponseWithFallback?: typeof generateStructuredAgentResponseWithFallback;
  getCheckoutStatus?: typeof getCheckoutStatus;
  renameCurrentBranch?: typeof renameCurrentBranch;
};

export type AgentMetadataGenerationOptions = {
  agentManager: AgentManager;
  agentId: string;
  cwd: string;
  initialPrompt?: string | null;
  explicitTitle?: string | null;
  paseoHome?: string;
  logger: Logger;
  deps?: AgentMetadataGeneratorDeps;
};

type AgentMetadataNeeds = {
  prompt: string | null;
  needsTitle: boolean;
  needsBranch: boolean;
};

function hasExplicitTitle(title?: string | null): boolean {
  return Boolean(title && title.trim().length > 0);
}

function normalizeAutoTitle(title: string): string | null {
  const normalized = title.trim();
  if (!normalized) {
    return null;
  }
  return normalized.slice(0, MAX_AUTO_AGENT_TITLE_CHARS).trim() || null;
}

async function canRenameBranch(
  cwd: string,
  paseoHome: string | undefined,
  getCheckoutStatusImpl: typeof getCheckoutStatus
): Promise<boolean> {
  let status: CheckoutStatusResult;
  try {
    status = await getCheckoutStatusImpl(cwd, { paseoHome });
  } catch {
    return false;
  }

  if (!status.isGit || !status.isPaseoOwnedWorktree) {
    return false;
  }

  if (!status.currentBranch) {
    return false;
  }

  const worktreeDirName = basename(status.repoRoot);
  return status.currentBranch === worktreeDirName;
}

export async function determineAgentMetadataNeeds(
  options: Pick<AgentMetadataGenerationOptions, "initialPrompt" | "explicitTitle" | "cwd" | "paseoHome" | "deps">
): Promise<AgentMetadataNeeds> {
  const prompt = options.initialPrompt?.trim();
  if (!prompt) {
    return { prompt: null, needsTitle: false, needsBranch: false };
  }

  const needsTitle = !hasExplicitTitle(options.explicitTitle);
  const getCheckoutStatusImpl = options.deps?.getCheckoutStatus ?? getCheckoutStatus;
  const needsBranch = await canRenameBranch(
    options.cwd,
    options.paseoHome,
    getCheckoutStatusImpl
  );

  return {
    prompt,
    needsTitle,
    needsBranch,
  };
}

function buildMetadataSchema(needs: AgentMetadataNeeds): z.ZodObject<any> | null {
  if (!needs.needsTitle && !needs.needsBranch) {
    return null;
  }

  const shape: Record<string, z.ZodTypeAny> = {};
  if (needs.needsTitle) {
    shape.title = z.string().min(1).max(MAX_AUTO_AGENT_TITLE_CHARS);
  }
  if (needs.needsBranch) {
    shape.branch = z.string().min(1).max(100);
  }
  return z.object(shape);
}

function buildPrompt(needs: AgentMetadataNeeds): string {
  const fields = [needs.needsTitle ? "title" : null, needs.needsBranch ? "branch" : null].filter(
    Boolean
  ) as string[];

  const instructions: string[] = [
    "Generate metadata for a coding agent based on the user prompt.",
  ];

  if (needs.needsTitle) {
    instructions.push(
      `Title: short descriptive label (<= ${MAX_AUTO_AGENT_TITLE_CHARS} chars).`
    );
  }
  if (needs.needsBranch) {
    instructions.push(
      "Branch: lowercase slug using letters, numbers, hyphens, and slashes only; no spaces, no uppercase, no leading/trailing hyphen, no consecutive hyphens."
    );
  }

  if (fields.length === 1) {
    instructions.push(`Return JSON only with a single field '${fields[0]}'.`);
  } else {
    instructions.push(`Return JSON only with fields '${fields.join("' and '")}'.`);
  }

  instructions.push("", "User prompt:", needs.prompt ?? "");
  return instructions.join("\n");
}

export async function generateAndApplyAgentMetadata(
  options: AgentMetadataGenerationOptions
): Promise<void> {
  const needs = await determineAgentMetadataNeeds(options);
  if (!needs.prompt) {
    return;
  }

  const schema = buildMetadataSchema(needs);
  if (!schema) {
    return;
  }

  const generator =
    options.deps?.generateStructuredAgentResponseWithFallback ??
    generateStructuredAgentResponseWithFallback;
  const getCheckoutStatusImpl = options.deps?.getCheckoutStatus ?? getCheckoutStatus;
  const renameCurrentBranchImpl = options.deps?.renameCurrentBranch ?? renameCurrentBranch;

  let result: { title?: string; branch?: string };

  try {
    result = await generator({
      manager: options.agentManager,
      cwd: options.cwd,
      prompt: buildPrompt(needs),
      schema,
      schemaName: "AgentMetadata",
      maxRetries: 2,
      providers: DEFAULT_STRUCTURED_GENERATION_PROVIDERS,
      agentConfigOverrides: {
        title: "Agent metadata generator",
        internal: true,
      },
    });
  } catch (error) {
    if (
      error instanceof StructuredAgentResponseError ||
      error instanceof StructuredAgentFallbackError
    ) {
      options.logger.warn(
        { err: error, agentId: options.agentId },
        "Structured metadata generation failed"
      );
      return;
    }
    options.logger.error(
      { err: error, agentId: options.agentId },
      "Agent metadata generation failed"
    );
    return;
  }

  if (needs.needsTitle && typeof result.title === "string") {
    const normalizedTitle = normalizeAutoTitle(result.title);
    if (normalizedTitle) {
      await options.agentManager.setTitle(options.agentId, normalizedTitle);
    }
  }

  if (needs.needsBranch && typeof result.branch === "string") {
    const normalizedBranch = result.branch.trim();
    const validation = validateBranchSlug(normalizedBranch);
    if (!validation.valid) {
      options.logger.warn(
        { agentId: options.agentId, branch: normalizedBranch, error: validation.error },
        "Generated branch name is invalid"
      );
      return;
    }

    let status: CheckoutStatusResult;
    try {
      status = await getCheckoutStatusImpl(options.cwd, { paseoHome: options.paseoHome });
    } catch (error) {
      options.logger.warn(
        { err: error, agentId: options.agentId },
        "Failed to re-check branch eligibility"
      );
      return;
    }

    if (!status.isGit || !status.isPaseoOwnedWorktree || !status.currentBranch) {
      return;
    }

    const worktreeDirName = basename(status.repoRoot);
    if (status.currentBranch !== worktreeDirName) {
      return;
    }

    try {
      await renameCurrentBranchImpl(options.cwd, normalizedBranch);
    } catch (error) {
      options.logger.warn(
        { err: error, agentId: options.agentId, branch: normalizedBranch },
        "Failed to rename branch"
      );
    }
  }
}

export function scheduleAgentMetadataGeneration(
  options: AgentMetadataGenerationOptions
): void {
  queueMicrotask(() => {
    void generateAndApplyAgentMetadata(options).catch((error) => {
      options.logger.error(
        { err: error, agentId: options.agentId },
        "Agent metadata generation crashed"
      );
    });
  });
}
