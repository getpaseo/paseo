import { z } from "zod";

import type { ToolCallDetail } from "../../agent-sdk-types.js";
import {
  ToolEditInputSchema,
  ToolEditOutputSchema,
  ToolReadInputSchema,
  ToolReadOutputSchema,
  ToolSearchInputSchema,
  ToolGrepOutputSchema,
  ToolGlobOutputSchema,
  ToolShellInputSchema,
  ToolShellOutputSchema,
  ToolWebFetchInputSchema,
  ToolWebFetchOutputSchema,
  ToolWebSearchOutputSchema,
  ToolWriteInputSchema,
  ToolWriteOutputSchema,
  toEditToolDetail,
  toFetchToolDetail,
  toReadToolDetail,
  toSearchToolDetail,
  toShellToolDetail,
  toWriteToolDetail,
  toolDetailBranchByName,
} from "../tool-call-detail-primitives.js";

const ClaudeGrepOutputSchema = z
  .union([
    ToolGrepOutputSchema,
    z
      .object({ output: z.string() })
      .passthrough()
      .transform(({ output }) => ({ numFiles: 0, filenames: [], content: output })),
  ])
  .nullable();

const ClaudeToolEnvelopeSchema = z
  .object({
    name: z.string().min(1),
    input: z.unknown().nullable(),
    output: z.unknown().nullable(),
  })
  .passthrough();

const ClaudeSpeakToolDetailSchema = z
  .object({
    name: z.literal("speak"),
    input: z
      .union([
        z.string().transform((text) => ({ text })),
        z.object({ text: z.string() }).passthrough(),
      ])
      .nullable(),
    output: z.unknown().nullable(),
  })
  .transform(({ input }) => {
    const text = input?.text?.trim() ?? "";
    if (!text) {
      return undefined;
    }
    return {
      type: "unknown",
      input: text,
      output: null,
    } satisfies ToolCallDetail;
  });

type ClaudePlainTextDetail = Extract<ToolCallDetail, { type: "plain_text" }>;

// Claude tool results arrive either as a bare string or wrapped in `{ output }`.
const ClaudeTextOutputSchema = z
  .union([
    z
      .object({ output: z.string() })
      .passthrough()
      .transform((value) => value.output),
    z.string(),
  ])
  .nullable();

function claudePlainTextDetail(
  label: string | undefined,
  text?: string | null,
  icon?: ClaudePlainTextDetail["icon"],
): ToolCallDetail | undefined {
  const trimmedLabel = label?.trim();
  const trimmedText = text?.trim();
  if (!trimmedLabel && !trimmedText) {
    return undefined;
  }
  return {
    type: "plain_text",
    ...(trimmedLabel ? { label: trimmedLabel } : {}),
    ...(trimmedText ? { text: trimmedText } : {}),
    ...(icon ? { icon } : {}),
  } satisfies ToolCallDetail;
}

function claudeWakeupLabel(input: { stop?: boolean; delaySeconds?: number } | null): string {
  if (input?.stop) {
    return "Stop loop";
  }
  if (typeof input?.delaySeconds === "number") {
    return formatWakeupDelay(input.delaySeconds);
  }
  return "Wakeup";
}

function formatWakeupDelay(seconds: number): string {
  if (seconds >= 3600) return `in ${Math.round(seconds / 3600)}h`;
  if (seconds >= 60) return `in ${Math.round(seconds / 60)}m`;
  return `in ${seconds}s`;
}

// Input schemas keep every field optional: tool input streams in as partial JSON,
// so a branch that required its fields would only match after the last token.
const ClaudeCronCreateInputSchema = z
  .object({ cron: z.string().optional(), prompt: z.string().optional() })
  .passthrough();
const ClaudeIdInputSchema = z.object({ id: z.string().optional() }).passthrough();
const ClaudeScheduleWakeupInputSchema = z
  .object({
    delaySeconds: z.number().optional(),
    reason: z.string().optional(),
    prompt: z.string().optional(),
    stop: z.boolean().optional(),
  })
  .passthrough();
const ClaudeMonitorInputSchema = z
  .object({
    description: z.string().optional(),
    command: z.string().optional(),
    ws: z.string().optional(),
  })
  .passthrough();
const ClaudeNotebookEditInputSchema = z
  .object({ notebook_path: z.string().optional(), new_source: z.string().optional() })
  .passthrough();
const ClaudeSendMessageInputSchema = z
  .object({
    to: z.string().optional(),
    summary: z.string().optional(),
    message: z.string().optional(),
  })
  .passthrough();
const ClaudePushNotificationInputSchema = z
  .object({ message: z.string().optional() })
  .passthrough();
const ClaudeTaskRefInputSchema = z
  .object({
    task_id: z.string().optional(),
    shell_id: z.string().optional(),
    taskId: z.string().optional(),
  })
  .passthrough();
const ClaudeEnterWorktreeInputSchema = z
  .object({ name: z.string().optional(), path: z.string().optional() })
  .passthrough();
const ClaudeExitWorktreeInputSchema = z.object({ action: z.string().optional() }).passthrough();
const ClaudeReportFindingsInputSchema = z
  .object({ level: z.string().optional(), findings: z.unknown().optional() })
  .passthrough();
const ClaudeDesignSyncInputSchema = z.object({ method: z.string().optional() }).passthrough();
const ClaudeToolSearchInputSchema = z.object({ query: z.string().optional() }).passthrough();
const ClaudeAskUserQuestionInputSchema = z
  .object({
    questions: z
      .array(
        z.object({ question: z.string().optional(), header: z.string().optional() }).passthrough(),
      )
      .optional(),
  })
  .passthrough();

const ClaudeToolDetailPass2Schema = z.union([
  toolDetailBranchByName("Bash", ToolShellInputSchema, ToolShellOutputSchema, toShellToolDetail),
  toolDetailBranchByName("bash", ToolShellInputSchema, ToolShellOutputSchema, toShellToolDetail),
  toolDetailBranchByName("shell", ToolShellInputSchema, ToolShellOutputSchema, toShellToolDetail),
  toolDetailBranchByName(
    "exec_command",
    ToolShellInputSchema,
    ToolShellOutputSchema,
    toShellToolDetail,
  ),
  toolDetailBranchByName("Read", ToolReadInputSchema, z.unknown(), (input, output) => {
    const parsedOutput = ToolReadOutputSchema.safeParse(output);
    return toReadToolDetail(input, parsedOutput.success ? parsedOutput.data : null);
  }),
  toolDetailBranchByName("read", ToolReadInputSchema, z.unknown(), (input, output) => {
    const parsedOutput = ToolReadOutputSchema.safeParse(output);
    return toReadToolDetail(input, parsedOutput.success ? parsedOutput.data : null);
  }),
  toolDetailBranchByName("read_file", ToolReadInputSchema, z.unknown(), (input, output) => {
    const parsedOutput = ToolReadOutputSchema.safeParse(output);
    return toReadToolDetail(input, parsedOutput.success ? parsedOutput.data : null);
  }),
  toolDetailBranchByName("view_file", ToolReadInputSchema, z.unknown(), (input, output) => {
    const parsedOutput = ToolReadOutputSchema.safeParse(output);
    return toReadToolDetail(input, parsedOutput.success ? parsedOutput.data : null);
  }),
  toolDetailBranchByName("Write", ToolWriteInputSchema, ToolWriteOutputSchema, toWriteToolDetail),
  toolDetailBranchByName("write", ToolWriteInputSchema, ToolWriteOutputSchema, toWriteToolDetail),
  toolDetailBranchByName(
    "write_file",
    ToolWriteInputSchema,
    ToolWriteOutputSchema,
    toWriteToolDetail,
  ),
  toolDetailBranchByName(
    "create_file",
    ToolWriteInputSchema,
    ToolWriteOutputSchema,
    toWriteToolDetail,
  ),
  toolDetailBranchByName("Edit", ToolEditInputSchema, ToolEditOutputSchema, toEditToolDetail),
  toolDetailBranchByName("MultiEdit", ToolEditInputSchema, ToolEditOutputSchema, toEditToolDetail),
  toolDetailBranchByName("multi_edit", ToolEditInputSchema, ToolEditOutputSchema, toEditToolDetail),
  toolDetailBranchByName("edit", ToolEditInputSchema, ToolEditOutputSchema, toEditToolDetail),
  toolDetailBranchByName(
    "apply_patch",
    ToolEditInputSchema,
    ToolEditOutputSchema,
    toEditToolDetail,
  ),
  toolDetailBranchByName("apply_diff", ToolEditInputSchema, ToolEditOutputSchema, toEditToolDetail),
  toolDetailBranchByName(
    "str_replace_editor",
    ToolEditInputSchema,
    ToolEditOutputSchema,
    toEditToolDetail,
  ),
  toolDetailBranchByName(
    "WebSearch",
    ToolSearchInputSchema,
    ToolWebSearchOutputSchema.nullable(),
    (input, output) => toSearchToolDetail({ input, output, toolName: "web_search" }),
  ),
  toolDetailBranchByName(
    "web_search",
    ToolSearchInputSchema,
    ToolWebSearchOutputSchema.nullable(),
    (input, output) => toSearchToolDetail({ input, output, toolName: "web_search" }),
  ),
  toolDetailBranchByName("search", ToolSearchInputSchema, z.unknown(), (input) =>
    toSearchToolDetail({ input, toolName: "search" }),
  ),
  toolDetailBranchByName("Grep", ToolSearchInputSchema, ClaudeGrepOutputSchema, (input, output) =>
    toSearchToolDetail({ input, output, toolName: "grep" }),
  ),
  toolDetailBranchByName("grep", ToolSearchInputSchema, ClaudeGrepOutputSchema, (input, output) =>
    toSearchToolDetail({ input, output, toolName: "grep" }),
  ),
  toolDetailBranchByName(
    "Glob",
    ToolSearchInputSchema,
    ToolGlobOutputSchema.nullable(),
    (input, output) => toSearchToolDetail({ input, output, toolName: "glob" }),
  ),
  toolDetailBranchByName(
    "glob",
    ToolSearchInputSchema,
    ToolGlobOutputSchema.nullable(),
    (input, output) => toSearchToolDetail({ input, output, toolName: "glob" }),
  ),
  toolDetailBranchByName(
    "WebFetch",
    ToolWebFetchInputSchema,
    ToolWebFetchOutputSchema,
    toFetchToolDetail,
  ),
  toolDetailBranchByName(
    "web_fetch",
    ToolWebFetchInputSchema,
    ToolWebFetchOutputSchema,
    toFetchToolDetail,
  ),
  toolDetailBranchByName(
    "WebFetchTool",
    ToolWebFetchInputSchema,
    ToolWebFetchOutputSchema,
    toFetchToolDetail,
  ),
  toolDetailBranchByName(
    "web_fetch_tool",
    ToolWebFetchInputSchema,
    ToolWebFetchOutputSchema,
    toFetchToolDetail,
  ),
  toolDetailBranchByName(
    "webfetch",
    ToolWebFetchInputSchema,
    ToolWebFetchOutputSchema,
    toFetchToolDetail,
  ),
  toolDetailBranchByName(
    "Skill",
    z.object({ skill: z.string() }).passthrough(),
    ClaudeTextOutputSchema,
    (input, output) => {
      const skillName = input?.skill;
      if (!skillName) {
        return undefined;
      }
      return {
        type: "plain_text" as const,
        label: skillName,
        icon: "sparkles" as const,
        ...(output ? { text: output } : {}),
      } satisfies ToolCallDetail;
    },
  ),
  toolDetailBranchByName(
    "CronCreate",
    ClaudeCronCreateInputSchema,
    ClaudeTextOutputSchema,
    (input) => claudePlainTextDetail(input?.cron, input?.prompt, "brain"),
  ),
  toolDetailBranchByName("CronDelete", ClaudeIdInputSchema, ClaudeTextOutputSchema, (input) =>
    claudePlainTextDetail(input?.id, null, "brain"),
  ),
  toolDetailBranchByName("CronList", z.unknown(), ClaudeTextOutputSchema, (_input, output) =>
    claudePlainTextDetail("Scheduled jobs", output, "brain"),
  ),
  toolDetailBranchByName(
    "ScheduleWakeup",
    ClaudeScheduleWakeupInputSchema,
    ClaudeTextOutputSchema,
    (input) => {
      return claudePlainTextDetail(
        claudeWakeupLabel(input),
        input?.reason ?? input?.prompt,
        "brain",
      );
    },
  ),
  toolDetailBranchByName(
    "Monitor",
    ClaudeMonitorInputSchema,
    ClaudeTextOutputSchema,
    (input, output) => {
      // Monitor usually watches a shell command; render it like any other shell call.
      if (input?.command) {
        return {
          type: "shell",
          command: input.command,
          ...(output ? { output } : {}),
        } satisfies ToolCallDetail;
      }
      return claudePlainTextDetail(input?.description ?? input?.ws, output, "eye");
    },
  ),
  toolDetailBranchByName("NotebookEdit", ClaudeNotebookEditInputSchema, z.unknown(), (input) =>
    input?.notebook_path
      ? ({
          type: "edit",
          filePath: input.notebook_path,
          ...(input.new_source ? { newString: input.new_source } : {}),
        } satisfies ToolCallDetail)
      : undefined,
  ),
  toolDetailBranchByName(
    "SendMessage",
    ClaudeSendMessageInputSchema,
    ClaudeTextOutputSchema,
    (input) => claudePlainTextDetail(input?.summary ?? input?.to, input?.message),
  ),
  toolDetailBranchByName(
    "PushNotification",
    ClaudePushNotificationInputSchema,
    ClaudeTextOutputSchema,
    (input) => claudePlainTextDetail(input?.message),
  ),
  toolDetailBranchByName("TaskStop", ClaudeTaskRefInputSchema, ClaudeTextOutputSchema, (input) =>
    claudePlainTextDetail(input?.task_id ?? input?.shell_id, null, "bot"),
  ),
  toolDetailBranchByName(
    "TaskOutput",
    ClaudeTaskRefInputSchema,
    ClaudeTextOutputSchema,
    (input, output) => claudePlainTextDetail(input?.task_id, output, "bot"),
  ),
  toolDetailBranchByName(
    "TaskGet",
    ClaudeTaskRefInputSchema,
    ClaudeTextOutputSchema,
    (input, output) => claudePlainTextDetail(input?.taskId, output, "bot"),
  ),
  toolDetailBranchByName(
    "EnterWorktree",
    ClaudeEnterWorktreeInputSchema,
    ClaudeTextOutputSchema,
    (input, output) => claudePlainTextDetail(input?.name ?? input?.path, output),
  ),
  toolDetailBranchByName(
    "ExitWorktree",
    ClaudeExitWorktreeInputSchema,
    ClaudeTextOutputSchema,
    (input, output) => claudePlainTextDetail(input?.action, output),
  ),
  toolDetailBranchByName(
    "ReportFindings",
    ClaudeReportFindingsInputSchema,
    ClaudeTextOutputSchema,
    (input) =>
      claudePlainTextDetail(
        input?.level ?? "Findings",
        typeof input?.findings === "string" ? input.findings : undefined,
      ),
  ),
  toolDetailBranchByName(
    "DesignSync",
    ClaudeDesignSyncInputSchema,
    ClaudeTextOutputSchema,
    (input, output) => claudePlainTextDetail(input?.method, output, "sparkles"),
  ),
  toolDetailBranchByName("ToolSearch", ClaudeToolSearchInputSchema, z.unknown(), (input) =>
    input?.query
      ? ({ type: "search", query: input.query, toolName: "search" } satisfies ToolCallDetail)
      : undefined,
  ),
  toolDetailBranchByName(
    "AskUserQuestion",
    ClaudeAskUserQuestionInputSchema,
    z.unknown(),
    (input) => {
      const first = input?.questions?.[0];
      return claudePlainTextDetail(
        first?.header ?? first?.question,
        first?.header ? first.question : undefined,
      );
    },
  ),
  ClaudeSpeakToolDetailSchema,
]);

export function deriveClaudeToolDetail(
  name: string,
  input: unknown,
  output: unknown,
): ToolCallDetail {
  const pass1 = ClaudeToolEnvelopeSchema.safeParse({
    name,
    input: input ?? null,
    output: output ?? null,
  });
  if (!pass1.success) {
    return {
      type: "unknown",
      input: input ?? null,
      output: output ?? null,
    };
  }

  const pass2 = ClaudeToolDetailPass2Schema.safeParse(pass1.data);
  if (pass2.success && pass2.data) {
    return pass2.data;
  }

  return {
    type: "unknown",
    input: pass1.data.input,
    output: pass1.data.output,
  };
}
