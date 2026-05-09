import { z } from "zod";
import type { Logger } from "pino";

import type { AgentManager } from "./agent-manager.js";
import {
  DEFAULT_STRUCTURED_GENERATION_PROVIDERS,
  StructuredAgentFallbackError,
  StructuredAgentResponseError,
  generateStructuredAgentResponseWithFallback,
} from "./agent-response-loop.js";
import { MAX_AUTO_AGENT_TITLE_CHARS } from "./agent-title-limits.js";
import { buildMetadataPrompt } from "../../utils/build-metadata-prompt.js";
import type { WorkspaceGitService } from "../workspace-git-service.js";

export interface AgentMetadataGeneratorDeps {
  generateStructuredAgentResponseWithFallback?: typeof generateStructuredAgentResponseWithFallback;
}

export interface AgentMetadataGenerationOptions {
  agentManager: AgentManager;
  agentId: string;
  cwd: string;
  workspaceGitService?: Pick<WorkspaceGitService, "resolveRepoRoot">;
  initialPrompt?: string | null;
  explicitTitle?: string | null;
  paseoHome?: string;
  logger: Logger;
  deps?: AgentMetadataGeneratorDeps;
}

interface AgentMetadataNeeds {
  prompt: string | null;
  needsTitle: boolean;
}

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

export async function determineAgentMetadataNeeds(
  options: Pick<
    AgentMetadataGenerationOptions,
    "initialPrompt" | "explicitTitle" | "cwd" | "paseoHome" | "deps"
  >,
): Promise<AgentMetadataNeeds> {
  const prompt = options.initialPrompt?.trim();
  if (!prompt) {
    return { prompt: null, needsTitle: false };
  }

  const needsTitle = !hasExplicitTitle(options.explicitTitle);

  return {
    prompt,
    needsTitle,
  };
}

function buildMetadataSchema(
  needs: AgentMetadataNeeds,
): z.ZodObject<Record<string, z.ZodTypeAny>> | null {
  if (!needs.needsTitle) {
    return null;
  }

  const shape: Record<string, z.ZodTypeAny> = {};
  if (needs.needsTitle) {
    shape.title = z.string().min(1).max(MAX_AUTO_AGENT_TITLE_CHARS);
  }
  return z.object(shape);
}

async function buildPrompt(
  needs: AgentMetadataNeeds,
  options: {
    cwd: string;
    workspaceGitService?: Pick<WorkspaceGitService, "resolveRepoRoot">;
  },
): Promise<string> {
  const beforeLines: string[] = ["Generate metadata for a coding agent based on the user prompt."];
  if (needs.needsTitle) {
    beforeLines.push(`Title: short descriptive label (<= ${MAX_AUTO_AGENT_TITLE_CHARS} chars).`);
  }

  return buildMetadataPrompt({
    cwd: options.cwd,
    workspaceGitService: options.workspaceGitService,
    configKey: "agentTitle",
    before: beforeLines.join("\n"),
    after: "Return JSON only with a single field 'title'.",
    trailing: `User prompt:\n${needs.prompt ?? ""}`,
  });
}

export async function generateAndApplyAgentMetadata(
  options: AgentMetadataGenerationOptions,
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

  let result: { title?: string };

  try {
    result = await generator({
      manager: options.agentManager,
      cwd: options.cwd,
      prompt: await buildPrompt(needs, {
        cwd: options.cwd,
        workspaceGitService: options.workspaceGitService,
      }),
      schema,
      schemaName: "AgentMetadata",
      maxRetries: 2,
      providers: DEFAULT_STRUCTURED_GENERATION_PROVIDERS,
      persistSession: false,
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
        "Structured metadata generation failed",
      );
      return;
    }
    options.logger.error(
      { err: error, agentId: options.agentId },
      "Agent metadata generation failed",
    );
    return;
  }

  if (needs.needsTitle && typeof result.title === "string") {
    const normalizedTitle = normalizeAutoTitle(result.title);
    if (normalizedTitle) {
      await options.agentManager.setTitle(options.agentId, normalizedTitle);
    }
  }
}

export function scheduleAgentMetadataGeneration(options: AgentMetadataGenerationOptions): void {
  queueMicrotask(() => {
    void generateAndApplyAgentMetadata(options).catch((error) => {
      options.logger.error(
        { err: error, agentId: options.agentId },
        "Agent metadata generation crashed",
      );
    });
  });
}
