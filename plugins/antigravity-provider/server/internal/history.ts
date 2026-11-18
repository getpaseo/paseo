import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type {
  ProviderLaunch,
  ProviderSessionConfig,
  ProviderTimelineItem,
} from "@getpaseo/plugin/server/provider";
import { toolItem } from "./timeline.js";
import type { Step } from "./wire.js";

const toolCallSchema = z.object({
  name: z.string(),
  args: z.record(z.string(), z.json()).default({}),
});

const transcriptStepSchema = z.object({
  step_index: z.number().int().nonnegative(),
  source: z.string(),
  type: z.string(),
  status: z.string().default("DONE"),
  created_at: z.string().optional(),
  content: z.string().optional(),
  error: z.string().optional(),
  tool_calls: z.array(toolCallSchema).default([]),
});

const subagentRequestSchema = z.object({
  TypeName: z.string().default("subagent"),
  Role: z.string().default(""),
  Prompt: z.string().default(""),
});

const subagentBatchSchema = z.object({
  Subagents: z.array(subagentRequestSchema),
});

const subagentOutputSchema = z.object({
  conversationId: z.string().nullable().default(null),
  logAbsoluteUri: z.string().default(""),
  workspaceUris: z.array(z.string()).default([]),
});

type TranscriptStep = z.infer<typeof transcriptStepSchema>;
type ToolCall = z.infer<typeof toolCallSchema>;
type SubagentRequest = z.infer<typeof subagentRequestSchema>;
type SubagentOutput = z.infer<typeof subagentOutputSchema>;
type SubagentChild = NonNullable<Step["subagent_info"]>["subagents"][number];

export interface TranscriptEntry {
  item: ProviderTimelineItem;
  timestamp?: string;
}

export interface HistoryOptions {
  conversationId: string;
  launch: ProviderLaunch;
  config: ProviderSessionConfig;
}

export async function readTranscriptHistory(options: HistoryOptions): Promise<TranscriptEntry[]> {
  const logsDir = path.join(
    resolveAppDataDir(options.launch, options.config),
    "brain",
    options.conversationId,
    ".system_generated",
    "logs",
  );
  const content = await readTranscriptFile(logsDir);
  if (content === null) return [];
  const steps = parseTranscriptLines(content);
  return buildTimelineEntries(options.conversationId, steps, options.config.systemPrompt);
}

async function readTranscriptFile(logsDir: string): Promise<string | null> {
  for (const fileName of ["transcript_full.jsonl", "transcript.jsonl"]) {
    try {
      return await readFile(path.join(logsDir, fileName), "utf8");
    } catch (error) {
      if (!isMissingFileError(error)) throw error;
    }
  }
  return null;
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function resolveAppDataDir(launch: ProviderLaunch, config: ProviderSessionConfig): string {
  for (let index = 0; index < launch.args.length; index += 1) {
    const arg = launch.args[index];
    if (arg.startsWith("--app_data_dir=")) {
      const value = arg.slice("--app_data_dir=".length);
      if (value) return value;
    }
    if (arg === "--app_data_dir" && index + 1 < launch.args.length && launch.args[index + 1]) {
      return launch.args[index + 1];
    }
  }
  const env = { ...launch.env, ...config.env };
  const home = env.HOME || env.USERPROFILE || os.homedir();
  return path.join(home, ".gemini", "antigravity-cli");
}

function parseTranscriptLines(content: string): TranscriptStep[] {
  const lines = content.split("\n").filter((line) => line.trim().length > 0);
  const steps: TranscriptStep[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    let raw: unknown;
    try {
      raw = JSON.parse(lines[index]);
    } catch (error) {
      if (error instanceof SyntaxError && index === lines.length - 1) break;
      throw error;
    }
    steps.push(transcriptStepSchema.parse(raw));
  }
  return steps;
}

function buildTimelineEntries(
  conversationId: string,
  steps: TranscriptStep[],
  systemPrompt?: string,
): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  let seenFirstUserMessage = false;
  let index = 0;
  while (index < steps.length) {
    const step = steps[index];
    if (step.source === "USER_EXPLICIT" && step.type === "USER_INPUT") {
      const stripPrompt = !seenFirstUserMessage ? systemPrompt : undefined;
      seenFirstUserMessage = true;
      const id = `step:${step.step_index}`;
      const text = extractUserText(step.content || "", stripPrompt);
      entries.push({
        item: { type: "user_message", id, messageId: id, text },
        timestamp: step.created_at,
      });
      index += 1;
      continue;
    }
    if (step.source === "MODEL" && step.type === "PLANNER_RESPONSE") {
      const outputs: TranscriptStep[] = [];
      let next = index + 1;
      while (
        next < steps.length &&
        steps[next].source === "MODEL" &&
        steps[next].type === "GENERIC"
      ) {
        outputs.push(steps[next]);
        next += 1;
      }
      for (let callIndex = 0; callIndex < step.tool_calls.length; callIndex += 1) {
        const outputStep = outputs[callIndex];
        const item = buildToolTimelineItem(conversationId, step, callIndex, outputStep);
        const timestamp = outputStep ? outputStep.created_at : step.created_at;
        entries.push({ item, timestamp });
      }
      if (step.content) {
        const id = `step:${step.step_index}:response`;
        entries.push({
          item: { type: "assistant_message", id, messageId: id, text: step.content },
          timestamp: step.created_at,
        });
      }
      index = next;
      continue;
    }
    index += 1;
  }
  return entries;
}

function extractUserText(rawContent: string, systemPrompt?: string): string {
  const tagMatch = /<USER_REQUEST>\r?\n?([\s\S]*?)\r?\n?<\/USER_REQUEST>/.exec(rawContent);
  let text = tagMatch ? tagMatch[1] : rawContent;
  if (systemPrompt && text.startsWith(`${systemPrompt}\n\n`)) {
    text = text.slice(systemPrompt.length + 2);
  }
  return text
    .split("\n")
    .filter((line) => !/^Attached image: .*paseo-antigravity-images-/.test(line))
    .join("\n");
}

function stripStepTimestamps(content: string): string {
  return content.replace(/^(?:(?:Created|Completed) At: [^\n]*\n)+/, "");
}

function buildToolTimelineItem(
  conversationId: string,
  plannerStep: TranscriptStep,
  callIndex: number,
  outputStep: TranscriptStep | undefined,
): ProviderTimelineItem {
  const call = plannerStep.tool_calls[callIndex];
  const stepIndex = outputStep ? outputStep.step_index : plannerStep.step_index;
  const id = outputStep
    ? `step:${outputStep.step_index}`
    : `step:${plannerStep.step_index}:tool:${callIndex}`;
  const isFailed = outputStep?.status === "ERROR";
  const isCompleted = outputStep?.status === "DONE";
  const cleanedOutput = outputStep?.content ? stripStepTimestamps(outputStep.content) : "";
  const errorMessage = outputStep?.error || cleanedOutput || "Antigravity tool failed";
  const state = isFailed ? "ERROR" : "DONE";
  const subagentInfo =
    call.name === "invoke_subagent" ? parseSubagentInfo(call, cleanedOutput) : null;
  const step: Step = {
    conversation_id: conversationId,
    step_index: stepIndex,
    state,
    step_type: subagentInfo ? "subagent" : "tool",
    text_delta: "",
    tool_name: call.name,
    tool_info: subagentInfo
      ? null
      : {
          name: call.name,
          parameters: call.args,
          output: cleanedOutput,
          error: isFailed ? { type: "TOOL_ERROR", message: errorMessage } : null,
        },
    subagent_info: subagentInfo,
    usage: null,
  };
  const mapped = toolItem(step, id);
  if (!isFailed && !isCompleted) {
    return { ...mapped, status: "canceled", error: null };
  }
  return mapped;
}

function parseSubagentInfo(
  call: ToolCall,
  output: string,
): NonNullable<Step["subagent_info"]> | null {
  const requested = parseRequestedSubagents(call.args);
  const created = parseJsonObjects(output);
  if (requested.length === 0 && created.length === 0) return null;
  const count = Math.max(requested.length, created.length);
  const subagents: SubagentChild[] = [];
  for (let index = 0; index < count; index += 1) {
    const req = requested[index];
    const out = created[index];
    subagents.push({
      type_name: req ? req.TypeName : "subagent",
      role: req ? req.Role : "",
      initial_prompt: req ? req.Prompt : "",
      conversation_id: out ? out.conversationId : null,
      log_uri: out ? out.logAbsoluteUri : "",
      workspace_uris: out ? out.workspaceUris : [],
    });
  }
  return { subagents };
}

function parseRequestedSubagents(args: Record<string, unknown>): SubagentRequest[] {
  const batch = subagentBatchSchema.safeParse(args);
  if (batch.success) return batch.data.Subagents;
  const single = subagentRequestSchema.safeParse(args);
  if (single.success) return [single.data];
  return [];
}

function parseJsonObjects(text: string): SubagentOutput[] {
  const parsed: SubagentOutput[] = [];
  for (const match of text.matchAll(/\{[\s\S]*?\n\}/g)) {
    try {
      const candidate = subagentOutputSchema.safeParse(JSON.parse(match[0]));
      if (candidate.success) parsed.push(candidate.data);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
    }
  }
  return parsed;
}
