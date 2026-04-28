import { Command, Option } from "commander";
import {
  getStructuredAgentResponse,
  StructuredAgentResponseError,
  type AgentSnapshotPayload,
} from "@getpaseo/server";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type {
  CommandOptions,
  SingleResult,
  OutputSchema,
  CommandError,
} from "../../output/index.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { lookup } from "mime-types";
import { parseDuration } from "../../utils/duration.js";
import { collectMultiple } from "../../utils/command-options.js";
import { resolveProviderAndModel } from "../../utils/provider-model.js";

export { resolveProviderAndModel } from "../../utils/provider-model.js";

export function addRunOptions(cmd: Command): Command {
  return cmd
    .description("Create and start an agent with a task")
    .argument("<prompt>", "The task/prompt for the agent")
    .option("-d, --detach", "Run in background (detached)")
    .option("--title <title>", "Assign a title to the agent")
    .addOption(new Option("--name <name>", "Hidden alias for --title").hideHelp())
    .option(
      "--provider <provider>",
      "Agent provider, or provider/model (e.g. codex or codex/gpt-5.4)",
    )
    .option(
      "--model <model>",
      "Model to use (e.g., claude-sonnet-4-20250514, claude-3-5-haiku-20241022)",
    )
    .option("--thinking <id>", "Thinking option ID to use for this run")
    .option("--mode <mode>", "Provider-specific mode (e.g., plan, default, bypass)")
    .option("--worktree <name>", "Create agent in a new git worktree")
    .option("--base <branch>", "Base branch for worktree (default: current branch)")
    .option(
      "--image <path>",
      "Attach image(s) to the initial prompt (can be used multiple times)",
      collectMultiple,
      [],
    )
    .option("--cwd <path>", "Working directory (default: current)")
    .option(
      "--label <key=value>",
      "Add label(s) to the agent (can be used multiple times)",
      collectMultiple,
      [],
    )
    .option(
      "--wait-timeout <duration>",
      "Maximum time to wait for agent to finish (e.g., 30s, 5m, 1h). Default: no limit",
    )
    .option(
      "--output-schema <schema>",
      "Output JSON matching the provided schema file path or inline JSON schema",
    );
}

/** Result type for agent run command */
export interface AgentRunResult {
  agentId: string;
  status: "created" | "running" | "completed" | "timeout" | "permission" | "error";
  provider: string;
  cwd: string;
  title: string | null;
}

/** Schema for agent run output */
export const agentRunSchema: OutputSchema<AgentRunResult> = {
  idField: "agentId",
  columns: [
    { header: "AGENT ID", field: "agentId", width: 12 },
    { header: "STATUS", field: "status", width: 10 },
    { header: "PROVIDER", field: "provider", width: 10 },
    { header: "CWD", field: "cwd", width: 30 },
    { header: "TITLE", field: "title", width: 20 },
  ],
};

export interface AgentRunOptions extends CommandOptions {
  detach?: boolean;
  title?: string;
  name?: string;
  provider?: string;
  model?: string;
  thinking?: string;
  mode?: string;
  worktree?: string;
  base?: string;
  image?: string[];
  cwd?: string;
  label?: string[];
  waitTimeout?: string;
  outputSchema?: string;
}

function toRunResult(
  agent: AgentSnapshotPayload,
  statusOverride?: AgentRunResult["status"],
): AgentRunResult {
  return {
    agentId: agent.id,
    status: statusOverride ?? (agent.status === "running" ? "running" : "created"),
    provider: agent.provider,
    cwd: agent.cwd,
    title: agent.title,
  };
}

function loadOutputSchema(value: string): Record<string, unknown> {
  const trimmed = value.trim();
  if (!trimmed) {
    const error: CommandError = {
      code: "INVALID_OUTPUT_SCHEMA",
      message: "--output-schema cannot be empty",
      details: "Provide a JSON schema file path or inline JSON object",
    };
    throw error;
  }

  let source = trimmed;
  if (!trimmed.startsWith("{")) {
    try {
      source = readFileSync(resolve(trimmed), "utf8");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const error: CommandError = {
        code: "INVALID_OUTPUT_SCHEMA",
        message: `Failed to read output schema file: ${trimmed}`,
        details: message,
      };
      throw error;
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const error: CommandError = {
      code: "INVALID_OUTPUT_SCHEMA",
      message: "Failed to parse output schema JSON",
      details: message,
    };
    throw error;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    const error: CommandError = {
      code: "INVALID_OUTPUT_SCHEMA",
      message: "Output schema must be a JSON object",
    };
    throw error;
  }

  return parsed as Record<string, unknown>;
}

class StructuredRunStatusError extends Error {
  readonly kind: "timeout" | "permission" | "error" | "empty";

  constructor(kind: "timeout" | "permission" | "error" | "empty", message: string) {
    super(message);
    this.name = "StructuredRunStatusError";
    this.kind = kind;
  }
}

async function fetchStructuredOutput(
  caller: (structuredPrompt: string) => Promise<string>,
  prompt: string,
  outputSchema: ReturnType<typeof loadOutputSchema>,
): Promise<Record<string, unknown>> {
  try {
    return await getStructuredAgentResponse<Record<string, unknown>>({
      caller,
      prompt,
      schema: outputSchema,
      schemaName: "RunOutput",
      maxRetries: 2,
    });
  } catch (err) {
    if (err instanceof StructuredRunStatusError) {
      throw {
        code: "OUTPUT_SCHEMA_FAILED",
        message: err.message,
      } satisfies CommandError;
    }
    if (err instanceof StructuredAgentResponseError) {
      throw {
        code: "OUTPUT_SCHEMA_FAILED",
        message: "Agent response did not match the required output schema",
        details:
          err.validationErrors.length > 0
            ? err.validationErrors.join("\n")
            : err.lastResponse || "No response",
      } satisfies CommandError;
    }
    throw err;
  }
}

type ConnectedDaemonClient = Awaited<ReturnType<typeof connectToDaemon>>;

export interface StructuredResponseTimelineClient {
  fetchAgentTimeline: ConnectedDaemonClient["fetchAgentTimeline"];
}

export async function resolveStructuredResponseMessage(options: {
  client: StructuredResponseTimelineClient;
  agentId: string;
  lastMessage: string | null;
}): Promise<string | null> {
  const direct = options.lastMessage?.trim();
  if (direct) {
    return direct;
  }

  try {
    const timeline = await options.client.fetchAgentTimeline(options.agentId, {
      direction: "tail",
      limit: 200,
    });
    for (let index = timeline.entries.length - 1; index >= 0; index -= 1) {
      const entry = timeline.entries[index];
      if (!entry || entry.item.type !== "assistant_message") {
        continue;
      }
      const text = entry.item.text.trim();
      if (text.length > 0) {
        return text;
      }
    }
  } catch {
    // Leave empty; caller will surface a consistent structured-output failure message.
  }

  return null;
}

function structuredRunSchema(output: Record<string, unknown>): OutputSchema<AgentRunResult> {
  return {
    ...agentRunSchema,
    serialize: () => output,
  };
}

function validateRunOptions(prompt: string, options: AgentRunOptions, outputSchema: unknown): void {
  if (!prompt || prompt.trim().length === 0) {
    throw {
      code: "MISSING_PROMPT",
      message: "A prompt is required",
      details: "Usage: paseo agent run [options] <prompt>",
    } satisfies CommandError;
  }

  if (options.base && !options.worktree) {
    throw {
      code: "INVALID_OPTIONS",
      message: "--base can only be used with --worktree",
      details: "Usage: paseo agent run --worktree <name> --base <branch> <prompt>",
    } satisfies CommandError;
  }

  if (outputSchema && options.detach) {
    throw {
      code: "INVALID_OPTIONS",
      message: "--output-schema cannot be used with --detach",
      details: "Structured output requires waiting for the agent to finish",
    } satisfies CommandError;
  }
}

function parseWaitTimeoutOption(waitTimeout: string | undefined): number {
  if (!waitTimeout) return 0;
  try {
    const ms = parseDuration(waitTimeout);
    if (ms <= 0) {
      throw new Error("Timeout must be positive");
    }
    return ms;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw {
      code: "INVALID_TIMEOUT",
      message: "Invalid wait timeout value",
      details: message,
    } satisfies CommandError;
  }
}

function loadRunImages(
  imagePaths: string[] | undefined,
): Array<{ data: string; mimeType: string }> | undefined {
  if (!imagePaths || imagePaths.length === 0) return undefined;
  return imagePaths.map((imagePath) => {
    const resolvedPath = resolve(imagePath);
    try {
      const imageData = readFileSync(resolvedPath);
      const mimeType = lookup(resolvedPath) || "application/octet-stream";
      if (!mimeType.startsWith("image/")) {
        throw new Error(`File is not an image: ${imagePath} (detected type: ${mimeType})`);
      }
      return {
        data: imageData.toString("base64"),
        mimeType,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to read image ${imagePath}: ${message}`, { cause: err });
    }
  });
}

function parseRunLabels(labelFlags: string[] | undefined): Record<string, string> {
  const labels: Record<string, string> = {};
  if (!labelFlags) return labels;
  for (const labelStr of labelFlags) {
    const eqIndex = labelStr.indexOf("=");
    if (eqIndex === -1) {
      throw {
        code: "INVALID_LABEL",
        message: `Invalid label format: ${labelStr}`,
        details: "Labels must be in key=value format",
      } satisfies CommandError;
    }
    const key = labelStr.slice(0, eqIndex);
    labels[key] = labelStr.slice(eqIndex + 1);
  }
  return labels;
}

async function connectToDaemonOrThrow(
  hostOption: string | undefined,
  host: string,
): Promise<ConnectedDaemonClient> {
  try {
    return await connectToDaemon({ host: hostOption });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${host}: ${message}`,
      details: "Start the daemon with: paseo daemon start",
    } satisfies CommandError;
  }
}

export async function runRunCommand(
  prompt: string,
  options: AgentRunOptions,
  _command: Command,
): Promise<SingleResult<AgentRunResult>> {
  const host = getDaemonHost({ host: options.host as string | undefined });
  const outputSchema = options.outputSchema ? loadOutputSchema(options.outputSchema) : undefined;

  validateRunOptions(prompt, options, outputSchema);
  const waitTimeoutMs = parseWaitTimeoutOption(options.waitTimeout);

  const resolvedProviderModel = resolveProviderAndModel(options);
  const resolvedTitle = options.title ?? options.name;

  const client = await connectToDaemonOrThrow(options.host as string | undefined, host);

  try {
    // Resolve working directory
    const cwd = options.cwd ?? process.cwd();
    const thinkingOptionId = options.thinking?.trim();
    if (options.thinking !== undefined && !thinkingOptionId) {
      const error: CommandError = {
        code: "INVALID_THINKING_OPTION",
        message: "--thinking cannot be empty",
        details:
          'Provide a thinking option ID. Use "paseo provider models <provider> --thinking" to list valid IDs.',
      };
      throw error;
    }

    const images = loadRunImages(options.image);

    const git = options.worktree
      ? {
          createWorktree: true,
          worktreeSlug: options.worktree,
          baseBranch: options.base,
        }
      : undefined;

    const labels = parseRunLabels(options.label);

    if (outputSchema) {
      let structuredAgent: AgentSnapshotPayload | null = null;

      const callStructuredTurn = async (structuredPrompt: string): Promise<string> => {
        if (!structuredAgent) {
          structuredAgent = await client.createAgent({
            provider: resolvedProviderModel.provider,
            cwd,
            title: resolvedTitle,
            modeId: options.mode,
            model: resolvedProviderModel.model,
            thinkingOptionId,
            initialPrompt: structuredPrompt,
            outputSchema,
            images,
            git,
            worktreeName: options.worktree,
            labels: Object.keys(labels).length > 0 ? labels : undefined,
          });
        } else {
          await client.sendMessage(structuredAgent.id, structuredPrompt);
        }

        const state = await client.waitForFinish(structuredAgent.id, waitTimeoutMs);
        if (state.status === "timeout") {
          throw new StructuredRunStatusError("timeout", "Timed out waiting for structured output");
        }
        if (state.status === "permission") {
          throw new StructuredRunStatusError(
            "permission",
            "Agent is waiting for permission before producing structured output",
          );
        }
        if (state.status === "error") {
          throw new StructuredRunStatusError(
            "error",
            state.error ?? "Agent failed before producing structured output",
          );
        }

        const lastMessage = await resolveStructuredResponseMessage({
          client,
          agentId: structuredAgent.id,
          lastMessage: state.lastMessage,
        });
        if (!lastMessage) {
          throw new StructuredRunStatusError(
            "empty",
            "Agent finished without a structured output message",
          );
        }

        return lastMessage;
      };

      const output = await fetchStructuredOutput(callStructuredTurn, prompt, outputSchema);

      if (!structuredAgent) {
        const error: CommandError = {
          code: "OUTPUT_SCHEMA_FAILED",
          message: "Agent finished without a structured output message",
        };
        throw error;
      }

      await client.close();

      return {
        type: "single",
        data: toRunResult(structuredAgent, "completed"),
        schema: structuredRunSchema(output),
      };
    }

    // Create the agent
    const agent = await client.createAgent({
      provider: resolvedProviderModel.provider,
      cwd,
      title: resolvedTitle,
      modeId: options.mode,
      model: resolvedProviderModel.model,
      thinkingOptionId,
      initialPrompt: prompt,
      images,
      git,
      worktreeName: options.worktree,
      labels: Object.keys(labels).length > 0 ? labels : undefined,
    });

    // Default run behavior is foreground: wait for completion unless --detach is set.
    if (!options.detach) {
      const state = await client.waitForFinish(agent.id, waitTimeoutMs);
      await client.close();

      const finalAgent = state.final ?? agent;
      const status: AgentRunResult["status"] = state.status === "idle" ? "completed" : state.status;

      return {
        type: "single",
        data: toRunResult(finalAgent, status),
        schema: agentRunSchema,
      };
    }

    await client.close();

    return {
      type: "single",
      data: toRunResult(agent),
      schema: agentRunSchema,
    };
  } catch (err) {
    await client.close().catch(() => {});

    if (err && typeof err === "object" && "code" in err) {
      throw err;
    }

    const message = err instanceof Error ? err.message : String(err);
    const error: CommandError = {
      code: "AGENT_CREATE_FAILED",
      message: `Failed to create agent: ${message}`,
    };
    throw error;
  }
}
