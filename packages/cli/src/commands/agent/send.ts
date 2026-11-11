import { type Command, Option } from "commander";
import type { ActiveTurnBehavior } from "@getpaseo/protocol/messages";
import { collectMultiple } from "../../utils/command-options.js";
import { connectToDaemon } from "../../utils/client.js";
import type {
  CommandOptions,
  SingleResult,
  OutputSchema,
  CommandError,
} from "../../output/index.js";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import {
  awaitStructuredTurn,
  fetchStructuredOutput,
  loadOutputSchema,
  markTimelineEnd,
  parseMaxRetriesOption,
  parseWaitTimeoutOption,
  validateStructuredOutputOptions,
} from "./run.js";

const DEFAULT_WAIT_TIMEOUT_MS = 600000;

/** Result type for agent send command */
export interface AgentSendResult {
  agentId: string;
  status: "queued" | "sent" | "completed" | "timeout" | "permission" | "error";
  message: string;
}

/** Schema for agent send output */
export const agentSendSchema: OutputSchema<AgentSendResult> = {
  idField: "agentId",
  columns: [
    { header: "AGENT ID", field: "agentId", width: 12 },
    { header: "STATUS", field: "status", width: 12 },
    { header: "MESSAGE", field: "message", width: 40 },
  ],
};

export interface AgentSendOptions extends CommandOptions {
  behavior?: ActiveTurnBehavior;
  wait?: boolean;
  image?: string[];
  prompt?: string;
  promptFile?: string;
  outputSchema?: string;
  maxRetries?: string;
  waitTimeout?: string;
}

export function addSendOptions(cmd: Command): Command {
  return cmd
    .description("Send a message/task to an existing agent")
    .argument("<id>", "Agent ID (or prefix)")
    .argument("[prompt]", "The message to send")
    .option("--prompt <text>", "Provide the message inline as a flag")
    .option("--prompt-file <path>", "Read the message from a UTF-8 text file")
    .option("--image <path>", "Attach image(s) to the message", collectMultiple, [])
    .addOption(
      new Option(
        "--behavior <behavior>",
        "Active-turn behavior (agent default: steer; otherwise: interrupt)",
      ).choices(["interrupt", "steer"]),
    )
    .option("--no-wait", "Return immediately without waiting for completion")
    .option(
      "--wait-timeout <duration>",
      "Maximum time to wait for the agent to finish (e.g., 30s, 5m, 1h). Default: 10m",
    )
    .option(
      "--output-schema <schema>",
      "Output JSON matching the provided schema file path or inline JSON schema",
    )
    .option(
      "--max-retries <n>",
      "Retries when the output does not match --output-schema (default: 2; 0 fails on the first mismatch)",
    );
}

/**
 * Read image files and convert them to base64 data URIs
 */
async function readImageFiles(
  imagePaths: string[],
): Promise<Array<{ data: string; mimeType: string }>> {
  return Promise.all(
    imagePaths.map(async (path) => {
      try {
        const buffer = await readFile(path);
        const ext = extname(path).toLowerCase();

        let mimeType = "image/jpeg";
        switch (ext) {
          case ".png":
            mimeType = "image/png";
            break;
          case ".jpg":
          case ".jpeg":
            mimeType = "image/jpeg";
            break;
          case ".gif":
            mimeType = "image/gif";
            break;
          case ".webp":
            mimeType = "image/webp";
            break;
          default:
            mimeType = "image/jpeg";
        }

        return { data: buffer.toString("base64"), mimeType };
      } catch (err) {
        if (err && typeof err === "object" && "code" in err) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw {
          code: "IMAGE_READ_ERROR",
          message: `Failed to read image file: ${path}`,
          details: message,
        } satisfies CommandError;
      }
    }),
  );
}

async function resolvePromptInput(options: {
  promptArgument: string | undefined;
  promptOption: string | undefined;
  promptFile: string | undefined;
}): Promise<string> {
  const promptText = options.promptArgument?.trim();
  const promptOptionText = options.promptOption?.trim();
  const promptFilePath = options.promptFile?.trim();
  const providedSourceCount = [promptText, promptOptionText, promptFilePath].filter(Boolean).length;

  if (providedSourceCount > 1) {
    const error: CommandError = {
      code: "CONFLICTING_PROMPT_INPUT",
      message: "Provide exactly one of prompt argument, --prompt, or --prompt-file",
    };
    throw error;
  }

  if (promptText) {
    return options.promptArgument as string;
  }

  if (promptOptionText) {
    return options.promptOption as string;
  }

  if (!promptFilePath) {
    const error: CommandError = {
      code: "MISSING_PROMPT",
      message: "A prompt is required",
      details:
        "Usage: paseo agent send [options] <id> [prompt] | --prompt <text> | --prompt-file <path>",
    };
    throw error;
  }

  try {
    return await readFile(resolve(promptFilePath), "utf8");
  } catch (err) {
    if (err && typeof err === "object" && "code" in err) throw err;
    const message = err instanceof Error ? err.message : String(err);
    const error: CommandError = {
      code: "PROMPT_FILE_READ_ERROR",
      message: `Failed to read prompt file: ${promptFilePath}`,
      details: message,
    };
    throw error;
  }
}

type SendWaitState = Awaited<
  ReturnType<Awaited<ReturnType<typeof connectToDaemon>>["waitForFinish"]>
>;

function buildSendResult(agentIdArg: string, state: SendWaitState): AgentSendResult {
  const agentId = state.final?.id ?? agentIdArg;
  if (state.status === "timeout") {
    return { agentId, status: "timeout", message: "Timed out waiting for agent to finish" };
  }
  if (state.status === "permission") {
    return { agentId, status: "permission", message: "Agent is waiting for permission" };
  }
  if (state.status === "error") {
    return {
      agentId,
      status: "error",
      message: state.error ?? "Agent finished with error",
    };
  }
  return { agentId, status: "completed", message: "Agent completed processing the message" };
}

type SendClient = Awaited<ReturnType<typeof connectToDaemon>>;

async function sendForStructuredOutput(
  client: SendClient,
  input: {
    agentIdArg: string;
    prompt: string;
    schema: Record<string, unknown>;
    maxRetries: number | undefined;
    waitTimeoutMs: number;
    images: Array<{ data: string; mimeType: string }> | undefined;
    sourceAgentId: string | undefined;
    activeTurnBehavior: ActiveTurnBehavior;
  },
): Promise<SingleResult<AgentSendResult>> {
  // Timeline reads need the full id, and the agent's older answers must not pass for
  // this turn's: each turn is read from the timeline end marked before it is sent.
  const target = await client.fetchAgent(input.agentIdArg);
  if (!target) {
    throw {
      code: "AGENT_NOT_FOUND",
      message: `Agent not found: ${input.agentIdArg}`,
    } satisfies CommandError;
  }
  const agentId = target.agent.id;
  // Retries go to the same agent, so the images only travel with the first message.
  let firstTurn = true;
  const callStructuredTurn = async (structuredPrompt: string): Promise<string> => {
    const since = await markTimelineEnd(client, agentId);
    await client.sendAgentMessage(agentId, structuredPrompt, {
      images: firstTurn ? input.images : undefined,
      sourceAgentId: input.sourceAgentId,
      activeTurnBehavior: input.activeTurnBehavior,
    });
    firstTurn = false;
    return awaitStructuredTurn(client, agentId, input.waitTimeoutMs, since);
  };

  const output = await fetchStructuredOutput(
    callStructuredTurn,
    input.prompt,
    input.schema,
    input.maxRetries,
  );
  await client.close();

  return {
    type: "single",
    data: { agentId, status: "completed", message: "Agent completed processing the message" },
    schema: { ...agentSendSchema, serialize: () => output },
  };
}

export async function runSendCommand(
  agentIdArg: string,
  prompt: string | undefined,
  options: AgentSendOptions,
  _command: Command,
): Promise<SingleResult<AgentSendResult>> {
  // Validate arguments
  if (!agentIdArg || agentIdArg.trim().length === 0) {
    const error: CommandError = {
      code: "MISSING_AGENT_ID",
      message: "Agent ID is required",
      details: "Usage: paseo agent send [options] <id> [prompt]",
    };
    throw error;
  }

  const outputSchema = options.outputSchema ? loadOutputSchema(options.outputSchema) : undefined;
  const maxRetries = parseMaxRetriesOption(options.maxRetries);
  validateStructuredOutputOptions({ outputSchema, maxRetries, waits: options.wait !== false });
  const waitTimeoutMs = parseWaitTimeoutOption(options.waitTimeout) || DEFAULT_WAIT_TIMEOUT_MS;

  const promptInput = await resolvePromptInput({
    promptArgument: prompt,
    promptOption: options.prompt,
    promptFile: options.promptFile,
  });

  const client = await connectToDaemon({ target: options.daemonTarget });

  try {
    // Read image files if provided
    const images =
      options.image && options.image.length > 0 ? await readImageFiles(options.image) : undefined;

    const sourceAgentId = process.env.PASEO_AGENT_ID?.trim() || undefined;
    const activeTurnBehavior = options.behavior ?? (sourceAgentId ? "steer" : "interrupt");

    if (outputSchema) {
      return await sendForStructuredOutput(client, {
        agentIdArg,
        prompt: promptInput,
        schema: outputSchema,
        maxRetries,
        waitTimeoutMs,
        images,
        sourceAgentId,
        activeTurnBehavior,
      });
    }

    // Send the message
    const receipt = await client.sendAgentMessage(agentIdArg, promptInput, {
      images,
      sourceAgentId,
      activeTurnBehavior,
    });

    // If --no-wait, return immediately
    if (options.wait === false) {
      await client.close();

      return {
        type: "single",
        data: {
          agentId: agentIdArg,
          status: receipt.deliveryStatus ?? "sent",
          message:
            receipt.deliveryStatus === "queued"
              ? "Message queued for delivery after two quiet seconds"
              : "Message sent, not waiting for completion",
        },
        schema: agentSendSchema,
      };
    }

    const state = await client.waitForFinish(agentIdArg, waitTimeoutMs);
    await client.close();

    return {
      type: "single",
      data: buildSendResult(agentIdArg, state),
      schema: agentSendSchema,
    };
  } catch (err) {
    await client.close().catch(() => {});

    // Re-throw CommandError as-is
    if (err && typeof err === "object" && "code" in err) {
      throw err;
    }

    const message = err instanceof Error ? err.message : String(err);
    const error: CommandError = {
      code: "SEND_FAILED",
      message: `Failed to send message: ${message}`,
    };
    throw error;
  }
}
