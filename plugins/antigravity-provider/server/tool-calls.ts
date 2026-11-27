import type { AcpToolCallSnapshot, AcpTransformer } from "@getpaseo/plugin/server/acp";
import type { ProviderToolCallDetail } from "@getpaseo/plugin/server/provider";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import { z } from "zod";

const shellInput = z.object({ CommandLine: z.string() });
const shellOutput = z.object({
  output: z.string().optional(),
  exit_code: z.number().nullable().optional(),
});
const fileRead = z.object({
  Path: z.string().optional(),
  StartLine: z.int().positive().optional(),
  EndLine: z.int().positive().optional(),
});
const fileWrite = z.object({
  Path: z.string(),
  Content: z.string().optional(),
  ArtifactMetadata: z
    .object({
      RequestFeedback: z.boolean().optional(),
    })
    .optional(),
});
const fileEdit = z.object({
  Path: z.string(),
  Target: z.string().optional(),
  Replacement: z.string().optional(),
});
const webSearch = z.object({ query: z.string() });
const askQuestionInput = z.object({
  questions: z.array(
    z.object({
      question: z.string(),
      options: z.array(z.string()).optional(),
    }),
  ),
});
const updateStepsInput = z.object({
  steps: z.array(
    z.object({
      title: z.string(),
      status: z.string(),
    }),
  ),
});
const invokeSubagentInput = z.object({
  TypeName: z.string().optional(),
  Role: z.string().optional(),
  Prompt: z.string().optional(),
});
const manageTaskInput = z.object({
  Action: z.string(),
  TaskId: z.string().optional(),
});
const scheduleInput = z.object({
  Prompt: z.string(),
  CronExpression: z.string().optional(),
  DurationSeconds: z.number().optional(),
});
const runWorkflowInput = z.object({
  Description: z.string().optional(),
  ScriptPath: z.string().optional(),
});
const swarmInput = z.object({
  action: z.string(),
  name: z.string().optional(),
  title: z.string().optional(),
  brief: z.string().optional(),
});

export const mapToolCall: NonNullable<AcpTransformer["toolCall"]> = (call, context) => {
  if (call.name?.startsWith("mcp_")) {
    return mapMcpCall(call, call.name, context.mcpServerNames ?? []);
  }
  const detail = mapNativeDetail(call);
  return detail ? { ...call, detail } : call;
};

function readContentText(content: JsonValue | undefined): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const entry of content) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    if (entry.type !== "content") continue;
    const body = entry.content;
    if (
      typeof body === "object" &&
      body !== null &&
      !Array.isArray(body) &&
      body.type === "text" &&
      typeof body.text === "string" &&
      body.text.length > 0
    ) {
      parts.push(body.text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function readOutputText(output: JsonValue): string | undefined {
  if (typeof output === "string" && output.length > 0) return output;
  if (typeof output !== "object" || output === null || Array.isArray(output)) return undefined;
  for (const key of ["output", "content", "text", "result"]) {
    const value = output[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function hasContentDiff(content: JsonValue | undefined): boolean {
  return (
    Array.isArray(content) &&
    content.some(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        !Array.isArray(entry) &&
        entry.type === "diff",
    )
  );
}

function mapNativeDetail(call: AcpToolCallSnapshot): ProviderToolCallDetail | undefined {
  const byName = mapNamedTool(call);
  if (byName) return byName;
  if (call.kind !== "read") return undefined;
  const input = fileRead.safeParse(call.input).data;
  const filePath = call.locations[0] ?? input?.Path;
  if (!filePath) return undefined;
  const { StartLine: offset, EndLine: end } = input ?? {};
  const content = readContentText(call.content) ?? readOutputText(call.output);
  return {
    type: "read",
    filePath,
    ...(content !== undefined ? { content } : {}),
    offset,
    limit:
      offset !== undefined && end !== undefined && end >= offset ? end - offset + 1 : undefined,
  };
}

function mapFileAndShellTool(call: AcpToolCallSnapshot): ProviderToolCallDetail | undefined {
  if (call.name === "run_command") {
    const input = shellInput.safeParse(call.input).data;
    if (!input) return undefined;
    const output = shellOutput.safeParse(call.output).data;
    return {
      type: "shell",
      command: input.CommandLine,
      output: output?.output,
      exitCode: output?.exit_code,
    };
  }
  if (call.name === "write_file") {
    const input = fileWrite.safeParse(call.input).data;
    if (!input) return undefined;
    if (input.ArtifactMetadata?.RequestFeedback === true && input.Content) {
      return { type: "plan", text: input.Content };
    }
    return { type: "write", filePath: input.Path, content: input.Content };
  }
  if (call.name === "edit_file" && !hasContentDiff(call.content)) {
    const input = fileEdit.safeParse(call.input).data;
    if (!input) return undefined;
    return {
      type: "edit",
      filePath: input.Path,
      oldString: input.Target,
      newString: input.Replacement,
    };
  }
  if (call.name === "search_web") {
    const input = webSearch.safeParse(call.input).data;
    if (input) return { type: "search", toolName: "web_search", query: input.query };
  }
  return undefined;
}

function mapAgentWorkflowTool(call: AcpToolCallSnapshot): ProviderToolCallDetail | undefined {
  if (call.name === "ask_question") {
    const input = askQuestionInput.safeParse(call.input).data;
    if (!input || input.questions.length === 0) return undefined;
    const label =
      input.questions.length === 1 ? "Question" : `Questions (${input.questions.length})`;
    const text = input.questions.map((item) => item.question).join("\n");
    return { type: "plain_text", label, icon: "sparkles", text };
  }
  if (call.name === "update_steps") {
    const input = updateStepsInput.safeParse(call.input).data;
    if (!input) return undefined;
    const text = input.steps.map((step) => `[${step.status}] ${step.title}`).join("\n");
    return { type: "plain_text", label: "Steps", icon: "sparkles", text };
  }
  if (call.name === "invoke_subagent") {
    const input = invokeSubagentInput.safeParse(call.input).data;
    if (!input) return undefined;
    return {
      type: "sub_agent",
      subAgentType: input.TypeName,
      description: input.Role ?? input.Prompt,
      log: readContentText(call.content) ?? readOutputText(call.output) ?? "",
    };
  }
  if (call.name === "run_workflow") {
    const input = runWorkflowInput.safeParse(call.input).data;
    if (!input) return undefined;
    return {
      type: "sub_agent",
      subAgentType: "workflow",
      description: input.Description ?? input.ScriptPath,
      log: readContentText(call.content) ?? readOutputText(call.output) ?? "",
    };
  }
  return undefined;
}

function mapTaskAndSwarmTool(call: AcpToolCallSnapshot): ProviderToolCallDetail | undefined {
  if (call.name === "manage_task") {
    const input = manageTaskInput.safeParse(call.input).data;
    if (!input) return undefined;
    const text = readContentText(call.content) ?? readOutputText(call.output);
    return { type: "plain_text", label: `Task ${input.Action}`, icon: "square_terminal", text };
  }
  if (call.name === "schedule") {
    const input = scheduleInput.safeParse(call.input).data;
    if (!input) return undefined;
    let label = "Schedule";
    if (input.CronExpression) label = `Schedule (${input.CronExpression})`;
    else if (input.DurationSeconds !== undefined) label = `Timer (${input.DurationSeconds}s)`;
    return { type: "plain_text", label, icon: "sparkles", text: input.Prompt };
  }
  if (call.name === "swarm") {
    const input = swarmInput.safeParse(call.input).data;
    if (!input) return undefined;
    const label = input.name ? `Swarm ${input.action} (${input.name})` : `Swarm ${input.action}`;
    return {
      type: "plain_text",
      label,
      icon: "bot",
      text: input.brief ?? input.title ?? readContentText(call.content),
    };
  }
  return undefined;
}

function mapNamedTool(call: AcpToolCallSnapshot): ProviderToolCallDetail | undefined {
  return mapFileAndShellTool(call) ?? mapAgentWorkflowTool(call) ?? mapTaskAndSwarmTool(call);
}

function mapMcpCall(
  call: AcpToolCallSnapshot,
  wireName: string,
  serverNames: readonly string[],
): AcpToolCallSnapshot {
  const qualifiedName = wireName.slice("mcp_".length);
  // The wire uses the same separator inside names and between the server and tool.
  // Paseo's own server can also appear when replaying with MCP disabled.
  const matchingServers = [...new Set([...serverNames, "paseo"])].filter((name) =>
    qualifiedName.startsWith(`${name}_`),
  );
  const server = matchingServers.length === 1 ? matchingServers[0] : undefined;
  let input = call.input;
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const { toolSummary: _summary, ...args } = input;
    input = args;
  }
  return {
    ...call,
    name: server ? `${server}.${qualifiedName.slice(server.length + 1)}` : wireName,
    detail: { type: "unknown", input, output: call.output },
  };
}
