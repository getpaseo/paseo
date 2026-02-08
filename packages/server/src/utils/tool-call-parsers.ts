import stripAnsi from "strip-ansi";
import { z } from "zod";

// ---- Tool Call Kind (icon category) ----

export type ToolCallKind =
  | "read"
  | "edit"
  | "execute"
  | "search"
  | "thinking"
  | "agent"
  | "tool";

const TOOL_KIND_MAP: Record<string, ToolCallKind> = {
  read: "read",
  read_file: "read",
  edit: "edit",
  write: "edit",
  apply_patch: "edit",
  bash: "execute",
  shell: "execute",
  grep: "search",
  glob: "search",
  web_search: "search",
  thinking: "thinking",
  task: "agent",
};

// ---- Tool Name Normalization ----

const TOOL_NAME_MAP: Record<string, string> = {
  shell: "Shell",
  bash: "Shell",
  read: "Read",
  read_file: "Read",
  apply_patch: "Edit",
  edit: "Edit",
  write: "Edit",
  paseo_worktree_setup: "Setup",
  thinking: "Thinking",
};

const TOOL_TOKEN_REGEX = /[a-z0-9]+/g;

export function normalizeToolDisplayName(toolName: string): string {
  const normalized = toolName.trim().toLowerCase();
  if (!normalized) {
    return toolName;
  }

  const tokens = normalized.match(TOOL_TOKEN_REGEX) ?? [];
  const leaf = tokens[tokens.length - 1];
  if (leaf === "speak") {
    return "Speak";
  }
  return toolName;
}

function resolveDisplayName(rawName: string): string {
  const normalizedName = rawName.trim().toLowerCase();
  const entry = TOOL_NAME_MAP[normalizedName];
  return normalizeToolDisplayName(entry ?? rawName);
}

function resolveKind(rawName: string): ToolCallKind {
  const lower = rawName.trim().toLowerCase();
  if (TOOL_KIND_MAP[lower]) {
    return TOOL_KIND_MAP[lower];
  }
  if (lower.startsWith("read")) {
    return "read";
  }
  return "tool";
}

// ---- Path/Command Utilities ----

export function stripCwdPrefix(filePath: string, cwd?: string): string {
  if (!cwd || !filePath) return filePath;

  const normalizedCwd = cwd.replace(/\\/g, "/").replace(/\/+$/, "");
  const normalizedPath = filePath.replace(/\\/g, "/");

  const prefix = `${normalizedCwd}/`;
  if (normalizedPath.startsWith(prefix)) {
    return normalizedPath.slice(prefix.length);
  }
  if (normalizedPath === normalizedCwd) {
    return ".";
  }
  return filePath;
}

const SHELL_WRAPPER_PREFIX_PATTERN =
  /^\/bin\/(?:zsh|bash|sh)\s+(?:-[a-zA-Z]+\s+)?/;
const CD_AND_PATTERN = /^cd\s+(?:"[^"]+"|'[^']+'|\S+)\s+&&\s+/;

export function stripShellWrapperPrefix(command: string): string {
  const prefixMatch = command.match(SHELL_WRAPPER_PREFIX_PATTERN);
  if (!prefixMatch) {
    return command;
  }

  let rest = command.slice(prefixMatch[0].length).trim();
  if (rest.length >= 2) {
    const first = rest[0];
    const last = rest[rest.length - 1];
    if ((first === `"` || first === `'`) && last === first) {
      rest = rest.slice(1, -1);
    }
  }

  return rest.replace(CD_AND_PATTERN, "");
}

// ---- Detail Types ----

export interface KeyValuePair {
  key: string;
  value: string;
}

export type ToolCallDetail =
  | { type: "shell"; command: string; output: string }
  | {
      type: "edit";
      filePath: string;
      oldString: string;
      newString: string;
      unifiedDiff?: string;
    }
  | {
      type: "read";
      filePath: string;
      content: string;
      offset?: number;
      limit?: number;
    }
  | { type: "thinking"; content: string }
  | { type: "generic"; input: KeyValuePair[]; output: KeyValuePair[] };

type ParsedToolCallContent = {
  detail: ToolCallDetail;
  summary?: string;
};

// ---- Generic Detail Schema ----

function stringifyValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  if (value === "") {
    return "";
  }
  const str = z.string().safeParse(value);
  if (str.success) {
    return str.data;
  }
  const num = z.number().safeParse(value);
  if (num.success) {
    return String(num.data);
  }
  const bool = z.boolean().safeParse(value);
  if (bool.success) {
    return String(bool.data);
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

const KeyValuePairsSchema = z.record(z.unknown()).transform((data) =>
  Object.entries(data).map(([key, value]) => ({
    key,
    value: stringifyValue(value),
  }))
);

const GenericDetailSchema = z
  .object({
    input: z.unknown().optional(),
    output: z.unknown().optional(),
  })
  .transform(
    (d): ToolCallDetail => ({
      type: "generic",
      input: KeyValuePairsSchema.catch([] as KeyValuePair[]).parse(d.input),
      output: KeyValuePairsSchema.catch([] as KeyValuePair[]).parse(d.output),
    })
  );

// ---- Tool Call Shape -> { summary, detail } ----

type ProviderCaseKey = "claude" | "codex" | "opencode" | "shared";
type ToolCaseKey =
  | "thinking"
  | "bash"
  | "shell"
  | "read"
  | "read_file"
  | "edit"
  | "write"
  | "apply_patch"
  | "task"
  | "todowrite"
  | "todo_write"
  | "update_plan"
  | "web_search"
  | "generic";

type NormalizedToolCallCase = {
  name: string;
  provider?: string;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  cwd?: string;
  providerCase: ProviderCaseKey;
  toolCase: ToolCaseKey;
  caseKey: `${ProviderCaseKey}:${ToolCaseKey}`;
};

const TOOL_CASE_NORMALIZATION_PATTERN = /[.\s-]+/g;

function normalizeProviderCase(provider?: string): ProviderCaseKey {
  const normalized = provider?.trim().toLowerCase();
  if (normalized === "claude") {
    return "claude";
  }
  if (normalized === "codex") {
    return "codex";
  }
  if (
    normalized === "opencode" ||
    normalized === "open_code" ||
    normalized === "open-code"
  ) {
    return "opencode";
  }
  return "shared";
}

function normalizeToolCaseName(name: string): string {
  return name
    .trim()
    .replace(TOOL_CASE_NORMALIZATION_PATTERN, "_")
    .toLowerCase();
}

function resolveToolCase(normalizedName: string): ToolCaseKey {
  const compact = normalizedName.replace(/_/g, "");
  if (normalizedName === "thinking" || compact === "thinking") {
    return "thinking";
  }
  if (normalizedName === "bash" || compact === "bash") {
    return "bash";
  }
  if (normalizedName === "shell" || compact === "shell") {
    return "shell";
  }
  if (normalizedName === "read" || compact === "read") {
    return "read";
  }
  if (normalizedName === "read_file" || compact === "readfile") {
    return "read_file";
  }
  if (normalizedName === "edit" || compact === "edit") {
    return "edit";
  }
  if (normalizedName === "write" || compact === "write") {
    return "write";
  }
  if (normalizedName === "apply_patch" || compact === "applypatch") {
    return "apply_patch";
  }
  if (normalizedName === "task" || compact === "task") {
    return "task";
  }
  if (normalizedName === "todowrite" || compact === "todowrite") {
    return "todowrite";
  }
  if (normalizedName === "todo_write") {
    return "todo_write";
  }
  if (normalizedName === "update_plan" || compact === "updateplan") {
    return "update_plan";
  }
  if (normalizedName === "web_search" || compact === "websearch") {
    return "web_search";
  }
  return "generic";
}

const CLAUDE_TOOL_CASES: ReadonlySet<ToolCaseKey> = new Set([
  "thinking",
  "bash",
  "shell",
  "read",
  "read_file",
  "edit",
  "write",
  "apply_patch",
  "task",
  "todowrite",
  "todo_write",
  "update_plan",
  "web_search",
  "generic",
]);

const CODEX_TOOL_CASES: ReadonlySet<ToolCaseKey> = new Set([
  "thinking",
  "bash",
  "shell",
  "read",
  "read_file",
  "edit",
  "write",
  "apply_patch",
  "task",
  "todowrite",
  "todo_write",
  "update_plan",
  "web_search",
  "generic",
]);

const OPENCODE_TOOL_CASES: ReadonlySet<ToolCaseKey> = new Set([
  "thinking",
  "bash",
  "shell",
  "read",
  "read_file",
  "edit",
  "write",
  "apply_patch",
  "task",
  "todowrite",
  "todo_write",
  "update_plan",
  "web_search",
  "generic",
]);

const SHARED_TOOL_CASES: ReadonlySet<ToolCaseKey> = new Set([
  "thinking",
  "bash",
  "shell",
  "read",
  "read_file",
  "edit",
  "write",
  "apply_patch",
  "task",
  "todowrite",
  "todo_write",
  "update_plan",
  "web_search",
  "generic",
]);

const PROVIDER_TOOL_CASES: Record<ProviderCaseKey, ReadonlySet<ToolCaseKey>> = {
  claude: CLAUDE_TOOL_CASES,
  codex: CODEX_TOOL_CASES,
  opencode: OPENCODE_TOOL_CASES,
  shared: SHARED_TOOL_CASES,
};

function resolveProviderToolCase(
  providerCase: ProviderCaseKey,
  normalizedName: string
): ToolCaseKey {
  const candidate = resolveToolCase(normalizedName);
  const allowed = PROVIDER_TOOL_CASES[providerCase];
  return allowed.has(candidate) ? candidate : "generic";
}

const ToolCallContentInputSchema = z
  .object({
    name: z.string().catch("unknown"),
    provider: z.string().optional(),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    metadata: z.record(z.unknown()).optional().catch(undefined),
    cwd: z.string().optional(),
  })
  .passthrough()
  .transform((toolCall): NormalizedToolCallCase => {
    const providerCase = normalizeProviderCase(toolCall.provider);
    const normalizedName = normalizeToolCaseName(toolCall.name);
    const toolCase = resolveProviderToolCase(providerCase, normalizedName);
    return {
      ...toolCall,
      providerCase,
      toolCase,
      caseKey: `${providerCase}:${toolCase}`,
    };
  });

const ShellCommandSchema = z
  .union([
    z.string(),
    z.array(z.string()).nonempty().transform((parts) => parts.join(" ")),
  ])
  .transform((command) => stripShellWrapperPrefix(command));

const ShellInputSchema = z.object({ command: ShellCommandSchema }).passthrough();

const ShellOutputCommandSchema = z
  .object({
    type: z.literal("command"),
    command: ShellCommandSchema.optional(),
  })
  .passthrough();

const ShellOutputTextSchema = z
  .union([
    z.string().transform((text) => stripAnsi(text)),
    z
      .object({
        type: z.literal("command"),
        output: z.string().optional(),
      })
      .passthrough()
      .transform((d) => stripAnsi(d.output ?? "")),
    z
      .object({
        type: z.literal("tool_result"),
        content: z.string(),
        is_error: z.literal(true),
      })
      .passthrough()
      .transform((d) => stripAnsi(d.content)),
  ])
  .catch("");

const ReadInputSchema = z.union([
  z
    .object({
      file_path: z.string(),
      offset: z.number().optional(),
      limit: z.number().optional(),
    })
    .passthrough()
    .transform((d) => ({
      filePath: d.file_path,
      offset: d.offset,
      limit: d.limit,
    })),
  z
    .object({
      filePath: z.string(),
      offset: z.number().optional(),
      limit: z.number().optional(),
    })
    .passthrough()
    .transform((d) => ({
      filePath: d.filePath,
      offset: d.offset,
      limit: d.limit,
    })),
  z
    .object({
      path: z.string(),
      offset: z.number().optional(),
      limit: z.number().optional(),
    })
    .passthrough()
    .transform((d) => ({
      filePath: d.path,
      offset: d.offset,
      limit: d.limit,
    })),
]);

const ReadOutputSchema = z.union([
  z
    .object({
      type: z.literal("file_read"),
      filePath: z.string(),
      content: z.string(),
    })
    .passthrough()
    .transform((d) => ({
      filePath: d.filePath,
      content: d.content,
    })),
  z
    .object({
      type: z.literal("read_file"),
      path: z.string(),
      content: z.string(),
    })
    .passthrough()
    .transform((d) => ({
      filePath: d.path,
      content: d.content,
    })),
  z.string().transform((content) => ({ content })),
]);

const EditInputSchema = z.union([
  z
    .object({
      file_path: z.string(),
      old_string: z.string(),
      new_string: z.string(),
      patch: z.string().optional(),
      diff: z.string().optional(),
    })
    .passthrough()
    .transform((d) => ({
      filePath: d.file_path,
      oldString: d.old_string,
      newString: d.new_string,
      unifiedDiff: d.patch ?? d.diff,
    })),
  z
    .object({
      file_path: z.string(),
      old_str: z.string(),
      new_str: z.string(),
      patch: z.string().optional(),
      diff: z.string().optional(),
    })
    .passthrough()
    .transform((d) => ({
      filePath: d.file_path,
      oldString: d.old_str,
      newString: d.new_str,
      unifiedDiff: d.patch ?? d.diff,
    })),
  z
    .object({
      file_path: z.string(),
      content: z.string(),
      patch: z.string().optional(),
      diff: z.string().optional(),
    })
    .passthrough()
    .transform((d) => ({
      filePath: d.file_path,
      oldString: "",
      newString: d.content,
      unifiedDiff: d.patch ?? d.diff,
    })),
  z
    .object({
      file_path: z.string(),
      patch: z.string().optional(),
      diff: z.string().optional(),
    })
    .passthrough()
    .transform((d) => ({
      filePath: d.file_path,
      oldString: "",
      newString: "",
      unifiedDiff: d.patch ?? d.diff,
    })),
  z
    .object({
      filePath: z.string(),
      oldContent: z.string().optional(),
      newContent: z.string().optional(),
      diff: z.string().optional(),
      patch: z.string().optional(),
    })
    .passthrough()
    .transform((d) => ({
      filePath: d.filePath,
      oldString: d.oldContent ?? "",
      newString: d.newContent ?? "",
      unifiedDiff: d.diff ?? d.patch,
    })),
  z
    .object({
      path: z.string(),
      content: z.string().optional(),
      diff: z.string().optional(),
      patch: z.string().optional(),
    })
    .passthrough()
    .transform((d) => ({
      filePath: d.path,
      oldString: "",
      newString: d.content ?? "",
      unifiedDiff: d.diff ?? d.patch,
    })),
]);

const EditOutputSchema = z.union([
  z
    .object({
      type: z.literal("file_edit"),
      filePath: z.string(),
      diff: z.string().optional(),
      oldContent: z.string().optional(),
      newContent: z.string().optional(),
    })
    .passthrough()
    .transform((d) => ({
      filePath: d.filePath,
      oldString: d.oldContent ?? "",
      newString: d.newContent ?? "",
      unifiedDiff: d.diff,
    })),
  z
    .object({
      type: z.literal("file_write"),
      filePath: z.string(),
      oldContent: z.string().optional(),
      newContent: z.string().optional(),
    })
    .passthrough()
    .transform((d) => ({
      filePath: d.filePath,
      oldString: d.oldContent ?? "",
      newString: d.newContent ?? "",
      unifiedDiff: undefined,
    })),
  z
    .object({
      files: z
        .array(
          z
            .object({
              path: z.string(),
              patch: z.string().optional(),
            })
            .passthrough()
        )
        .nonempty(),
    })
    .passthrough()
    .transform((d) => {
      const firstFile = d.files[0];
      return {
        filePath: firstFile.path,
        oldString: "",
        newString: "",
        unifiedDiff: firstFile.patch,
      };
    }),
]);

const ApplyPatchMovePathSchema = z
  .union([
    z.string().transform(() => undefined),
    z
      .object({
        movePath: z.string().nullable().optional(),
        move_path: z.string().nullable().optional(),
      })
      .passthrough()
      .transform((d) => d.movePath ?? d.move_path ?? undefined),
  ])
  .optional();

const ApplyPatchInputFileSchema = z
  .object({
    path: z.string(),
    kind: ApplyPatchMovePathSchema,
  })
  .transform((d) => ({
    path: d.path,
    movePath: d.kind,
  }));

const ApplyPatchResultFileSchema = z
  .object({
    path: z.string(),
    patch: z.string().optional(),
    kind: ApplyPatchMovePathSchema,
  })
  .transform((d) => ({
    path: d.path,
    patch: d.patch,
    movePath: d.kind,
  }));

const ApplyPatchInputSchema = z
  .object({
    files: z.array(ApplyPatchInputFileSchema).min(1),
  })
  .passthrough();

const ApplyPatchOutputSchema = z
  .object({
    files: z.array(ApplyPatchResultFileSchema).optional(),
    message: z.string().optional(),
    success: z.boolean().optional(),
  })
  .passthrough();

const GenericPathSummaryInputSchema = z.union([
  z.object({ file_path: z.string() }).passthrough().transform((d) => d.file_path),
  z.object({ filePath: z.string() }).passthrough().transform((d) => d.filePath),
  z.object({ path: z.string() }).passthrough().transform((d) => d.path),
]);

const GenericTextSummaryInputSchema = z.union([
  z.object({ description: z.string() }).passthrough().transform((d) => d.description),
  z.object({ title: z.string() }).passthrough().transform((d) => d.title),
  z.object({ name: z.string() }).passthrough().transform((d) => d.name),
  z.object({ branch: z.string() }).passthrough().transform((d) => d.branch),
  z.object({ pattern: z.string() }).passthrough().transform((d) => d.pattern),
  z.object({ query: z.string() }).passthrough().transform((d) => d.query),
  z.object({ url: z.string() }).passthrough().transform((d) => d.url),
  z.object({ text: z.string() }).passthrough().transform((d) => d.text),
]);

const GenericFilesSummaryInputSchema = z
  .object({
    files: z.array(z.object({ path: z.string() })).nonempty(),
  })
  .passthrough();

const GenericTodosSummaryInputSchema = z
  .object({
    todos: z
      .array(
        z.object({
          content: z.string(),
          status: z.enum(["pending", "in_progress", "completed"]),
          activeForm: z.string().optional(),
        })
      )
      .nonempty(),
  })
  .passthrough();

const GenericPlanSummaryInputSchema = z
  .object({
    plan: z
      .array(
        z.object({
          step: z.string(),
          status: z.enum(["pending", "in_progress", "completed"]).catch("pending"),
        })
      )
      .nonempty(),
  })
  .passthrough();

const TaskSummaryInputSchema = z.union([
  z.object({ description: z.string() }).passthrough().transform((d) => d.description),
  z.object({ title: z.string() }).passthrough().transform((d) => d.title),
]);

function resolveTodoSummary(input: unknown): string | undefined {
  const todos = GenericTodosSummaryInputSchema.safeParse(input);
  if (todos.success) {
    const inProgress = todos.data.todos.find(
      (todo) => todo.status === "in_progress"
    );
    return inProgress
      ? inProgress.activeForm ?? inProgress.content
      : `${todos.data.todos.length} tasks`;
  }

  const plan = GenericPlanSummaryInputSchema.safeParse(input);
  if (plan.success) {
    const inProgress = plan.data.plan.find(
      (entry) => entry.status === "in_progress"
    );
    return inProgress ? inProgress.step : `${plan.data.plan.length} tasks`;
  }

  return undefined;
}

function resolveGenericSummary(
  input: unknown,
  cwd?: string
): string | undefined {
  const path = GenericPathSummaryInputSchema.safeParse(input);
  if (path.success) {
    return stripCwdPrefix(path.data, cwd);
  }

  const text = GenericTextSummaryInputSchema.safeParse(input);
  if (text.success) {
    return text.data;
  }

  const files = GenericFilesSummaryInputSchema.safeParse(input);
  if (files.success) {
    return stripCwdPrefix(files.data.files[0].path, cwd);
  }

  return resolveTodoSummary(input);
}

function parseThinkingToolCall(
  toolCall: NormalizedToolCallCase
): ParsedToolCallContent {
  return {
    detail: {
      type: "thinking",
      content: z.string().catch("").parse(toolCall.input),
    },
  };
}

function parseShellToolCall(
  toolCall: NormalizedToolCallCase
): ParsedToolCallContent {
  const input = ShellInputSchema.safeParse(toolCall.input);
  const outputCommand = ShellOutputCommandSchema.safeParse(toolCall.output);
  const command =
    input.success
      ? input.data.command
      : outputCommand.success
        ? outputCommand.data.command ?? ""
        : "";

  return {
    summary: command.length > 0 ? command : undefined,
    detail: {
      type: "shell",
      command,
      output: ShellOutputTextSchema.parse(toolCall.output),
    },
  };
}

function parseGenericToolCall(
  toolCall: NormalizedToolCallCase
): ParsedToolCallContent {
  return {
    summary: resolveGenericSummary(toolCall.input, toolCall.cwd),
    detail: GenericDetailSchema.parse(toolCall),
  };
}

function parseReadToolCall(
  toolCall: NormalizedToolCallCase
): ParsedToolCallContent {
  const input = ReadInputSchema.safeParse(toolCall.input);
  const output = ReadOutputSchema.safeParse(toolCall.output);
  const outputFilePath =
    output.success && "filePath" in output.data
      ? output.data.filePath
      : undefined;
  const filePath =
    input.success
      ? input.data.filePath
      : outputFilePath;

  if (!filePath) {
    return parseGenericToolCall(toolCall);
  }

  return {
    summary: stripCwdPrefix(filePath, toolCall.cwd),
    detail: {
      type: "read",
      filePath,
      content: output.success ? output.data.content : "",
      offset: input.success ? input.data.offset : undefined,
      limit: input.success ? input.data.limit : undefined,
    },
  };
}

function parseEditToolCall(
  toolCall: NormalizedToolCallCase
): ParsedToolCallContent {
  const input = EditInputSchema.safeParse(toolCall.input);
  const output = EditOutputSchema.safeParse(toolCall.output);
  const filePath =
    input.success
      ? input.data.filePath
      : output.success
        ? output.data.filePath
        : undefined;

  if (!filePath) {
    return parseGenericToolCall(toolCall);
  }

  const unifiedDiff =
    (input.success ? input.data.unifiedDiff : undefined) ??
    (output.success ? output.data.unifiedDiff : undefined);

  return {
    summary: stripCwdPrefix(filePath, toolCall.cwd),
    detail: {
      type: "edit",
      filePath,
      oldString: input.success
        ? input.data.oldString
        : output.success
          ? output.data.oldString
          : "",
      newString: input.success
        ? input.data.newString
        : output.success
          ? output.data.newString
          : "",
      ...(unifiedDiff ? { unifiedDiff } : {}),
    },
  };
}

function parseApplyPatchToolCall(
  toolCall: NormalizedToolCallCase
): ParsedToolCallContent {
  const input = ApplyPatchInputSchema.safeParse(toolCall.input);
  const output = ApplyPatchOutputSchema.safeParse(toolCall.output);

  if (input.success) {
    const firstFile = input.data.files[0];
    const outputFiles = output.success ? output.data.files ?? [] : [];
    const matchPaths = z.array(z.string()).parse(
      [firstFile.path, firstFile.movePath].filter(Boolean)
    );
    const matched =
      outputFiles.find((file) => matchPaths.includes(file.path)) ??
      outputFiles[0];

    return {
      summary: stripCwdPrefix(firstFile.path, toolCall.cwd),
      detail: {
        type: "edit",
        filePath: firstFile.movePath ?? firstFile.path,
        oldString: "",
        newString: "",
        ...(matched?.patch ? { unifiedDiff: matched.patch } : {}),
      },
    };
  }

  if (output.success && output.data.files && output.data.files.length > 0) {
    const firstFile = output.data.files[0];
    return {
      summary: stripCwdPrefix(firstFile.path, toolCall.cwd),
      detail: {
        type: "edit",
        filePath: firstFile.path,
        oldString: "",
        newString: "",
        ...(firstFile.patch ? { unifiedDiff: firstFile.patch } : {}),
      },
    };
  }

  return parseGenericToolCall(toolCall);
}

function parseTaskToolCall(
  toolCall: NormalizedToolCallCase
): ParsedToolCallContent {
  const parsedSummary = TaskSummaryInputSchema.safeParse(toolCall.input);
  const summary = parsedSummary.success
    ? parsedSummary.data
    : resolveGenericSummary(toolCall.input, toolCall.cwd);
  return {
    summary,
    detail: GenericDetailSchema.parse(toolCall),
  };
}

function parseTodosToolCall(
  toolCall: NormalizedToolCallCase
): ParsedToolCallContent {
  return {
    summary:
      resolveTodoSummary(toolCall.input) ??
      resolveGenericSummary(toolCall.input, toolCall.cwd),
    detail: GenericDetailSchema.parse(toolCall),
  };
}

function createToolCaseSchema(
  caseKey: `${ProviderCaseKey}:${ToolCaseKey}`
) {
  return z
    .object({
      caseKey: z.literal(caseKey),
    })
    .passthrough();
}

function parseKnownToolCall(
  toolCall: NormalizedToolCallCase
): ParsedToolCallContent {
  switch (toolCall.toolCase) {
    case "thinking":
      return parseThinkingToolCall(toolCall);
    case "bash":
    case "shell":
      return parseShellToolCall(toolCall);
    case "read":
    case "read_file":
      return parseReadToolCall(toolCall);
    case "edit":
    case "write":
      return parseEditToolCall(toolCall);
    case "apply_patch":
      return parseApplyPatchToolCall(toolCall);
    case "task":
      return parseTaskToolCall(toolCall);
    case "todowrite":
    case "todo_write":
    case "update_plan":
      return parseTodosToolCall(toolCall);
    case "web_search":
    case "generic":
      return parseGenericToolCall(toolCall);
  }
}

const ClaudeToolCallContentSchema = z
  .discriminatedUnion("caseKey", [
    createToolCaseSchema("claude:thinking"),
    createToolCaseSchema("claude:bash"),
    createToolCaseSchema("claude:shell"),
    createToolCaseSchema("claude:read"),
    createToolCaseSchema("claude:read_file"),
    createToolCaseSchema("claude:edit"),
    createToolCaseSchema("claude:write"),
    createToolCaseSchema("claude:apply_patch"),
    createToolCaseSchema("claude:task"),
    createToolCaseSchema("claude:todowrite"),
    createToolCaseSchema("claude:todo_write"),
    createToolCaseSchema("claude:update_plan"),
    createToolCaseSchema("claude:web_search"),
    createToolCaseSchema("claude:generic"),
  ])
  .transform((toolCall): ParsedToolCallContent =>
    parseKnownToolCall(toolCall as NormalizedToolCallCase)
  );

const CodexToolCallContentSchema = z
  .discriminatedUnion("caseKey", [
    createToolCaseSchema("codex:thinking"),
    createToolCaseSchema("codex:bash"),
    createToolCaseSchema("codex:shell"),
    createToolCaseSchema("codex:read"),
    createToolCaseSchema("codex:read_file"),
    createToolCaseSchema("codex:edit"),
    createToolCaseSchema("codex:write"),
    createToolCaseSchema("codex:apply_patch"),
    createToolCaseSchema("codex:task"),
    createToolCaseSchema("codex:todowrite"),
    createToolCaseSchema("codex:todo_write"),
    createToolCaseSchema("codex:update_plan"),
    createToolCaseSchema("codex:web_search"),
    createToolCaseSchema("codex:generic"),
  ])
  .transform((toolCall): ParsedToolCallContent =>
    parseKnownToolCall(toolCall as NormalizedToolCallCase)
  );

const OpenCodeToolCallContentSchema = z
  .discriminatedUnion("caseKey", [
    createToolCaseSchema("opencode:thinking"),
    createToolCaseSchema("opencode:bash"),
    createToolCaseSchema("opencode:shell"),
    createToolCaseSchema("opencode:read"),
    createToolCaseSchema("opencode:read_file"),
    createToolCaseSchema("opencode:edit"),
    createToolCaseSchema("opencode:write"),
    createToolCaseSchema("opencode:apply_patch"),
    createToolCaseSchema("opencode:task"),
    createToolCaseSchema("opencode:todowrite"),
    createToolCaseSchema("opencode:todo_write"),
    createToolCaseSchema("opencode:update_plan"),
    createToolCaseSchema("opencode:web_search"),
    createToolCaseSchema("opencode:generic"),
  ])
  .transform((toolCall): ParsedToolCallContent =>
    parseKnownToolCall(toolCall as NormalizedToolCallCase)
  );

const SharedToolCallContentSchema = z
  .discriminatedUnion("caseKey", [
    createToolCaseSchema("shared:thinking"),
    createToolCaseSchema("shared:bash"),
    createToolCaseSchema("shared:shell"),
    createToolCaseSchema("shared:read"),
    createToolCaseSchema("shared:read_file"),
    createToolCaseSchema("shared:edit"),
    createToolCaseSchema("shared:write"),
    createToolCaseSchema("shared:apply_patch"),
    createToolCaseSchema("shared:task"),
    createToolCaseSchema("shared:todowrite"),
    createToolCaseSchema("shared:todo_write"),
    createToolCaseSchema("shared:update_plan"),
    createToolCaseSchema("shared:web_search"),
    createToolCaseSchema("shared:generic"),
  ])
  .transform((toolCall): ParsedToolCallContent =>
    parseKnownToolCall(toolCall as NormalizedToolCallCase)
  );

const ToolCallContentSchema = ToolCallContentInputSchema.pipe(
  z.union([
    ClaudeToolCallContentSchema,
    CodexToolCallContentSchema,
    OpenCodeToolCallContentSchema,
    SharedToolCallContentSchema,
  ])
);

const MetadataSummarySchema = z
  .object({ subAgentActivity: z.string() })
  .transform((d) => d.subAgentActivity);

function resolveMetadataSummary(
  toolName: string,
  metadata: Record<string, unknown> | undefined
): string | undefined {
  if (toolName.trim().toLowerCase() !== "task") {
    return undefined;
  }
  const parsed = MetadataSummarySchema.safeParse(metadata);
  if (!parsed.success) {
    return undefined;
  }
  const summary = parsed.data.trim();
  return summary.length > 0 ? summary : undefined;
}

// ---- Error formatting ----

const ErrorTextSchema = z.union([
  z.undefined().transform(() => undefined),
  z.null().transform(() => undefined),
  z.string(),
  z
    .object({
      type: z.literal("tool_result"),
      content: z.string(),
    })
    .passthrough()
    .transform((d) => d.content),
  z.unknown().transform((value) => {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }),
]);

// ---- Unified ToolCallDisplayInfo ----

export interface ToolCallInput {
  name: string;
  provider?: string;
  input?: unknown;
  output?: unknown;
  error?: unknown;
  metadata?: Record<string, unknown>;
  cwd?: string;
}

export interface ToolCallDisplayInfo {
  displayName: string;
  kind: ToolCallKind;
  summary?: string;
  detail: ToolCallDetail;
  errorText?: string;
}

export const ToolCallDisplaySchema = z
  .object({
    name: z.string().catch("unknown"),
    provider: z.string().optional(),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    error: z.unknown().optional(),
    metadata: z.record(z.unknown()).optional().catch(undefined),
    cwd: z.string().optional().catch(undefined),
  })
  .transform((toolCall): ToolCallDisplayInfo => {
    const parsed = ToolCallContentSchema.parse(toolCall);
    const metadataSummary = resolveMetadataSummary(
      toolCall.name,
      toolCall.metadata
    );

    return {
      displayName: resolveDisplayName(toolCall.name),
      kind: resolveKind(toolCall.name),
      summary: metadataSummary ?? parsed.summary,
      detail: parsed.detail,
      errorText: ErrorTextSchema.parse(toolCall.error),
    };
  });

export function parseToolCallDisplay(toolCall: ToolCallInput): ToolCallDisplayInfo {
  return ToolCallDisplaySchema.parse(toolCall);
}

// ---- TodoWrite Extraction ----

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

export function extractTodos(value: unknown): TodoItem[] {
  const parsed = z.object({
    todos: z.array(z.object({
      content: z.string(),
      status: z.enum(["pending", "in_progress", "completed"]),
      activeForm: z.string().optional(),
    })),
  }).safeParse(value);

  if (!parsed.success) {
    return [];
  }

  return parsed.data.todos;
}
