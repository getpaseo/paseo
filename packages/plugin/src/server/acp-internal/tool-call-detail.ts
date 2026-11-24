import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type { AcpToolCallSnapshot } from "../acp.js";
import type { ProviderToolCallDetail } from "../provider.js";

type JsonRecord = Readonly<Record<string, JsonValue>>;

interface ToolCallParts {
  call: AcpToolCallSnapshot;
  input: JsonRecord;
  output: JsonRecord;
  text: string | undefined;
}

type KindDetail = (parts: ToolCallParts) => ProviderToolCallDetail;

const KIND_DETAILS = new Map<string, KindDetail>(
  Object.entries({
    read: ({ call, input, output, text }) => ({
      type: "read",
      filePath: call.locations[0] ?? string(input, "path", "filePath", "file") ?? call.title,
      content: text ?? string(output, "content", "text"),
      offset: number(input, "offset", "line"),
      limit: number(input, "limit"),
    }),
    edit: editDetail,
    delete: editDetail,
    search: ({ call, input, output, text }) => ({
      type: "search",
      query: string(input, "query", "pattern") ?? call.title,
      toolName: "search",
      content: text ?? string(output, "content", "text"),
      filePaths: call.locations.length > 0 ? [...call.locations] : undefined,
    }),
    execute: ({ call, input, output, text }) => ({
      type: "shell",
      command: shellCommand(input) ?? call.title,
      cwd: string(input, "cwd"),
      output: text ?? string(output, "output", "text"),
      exitCode: number(output, "exitCode"),
    }),
    fetch: ({ call, input, output, text }) => ({
      type: "fetch",
      url: string(input, "url") ?? call.title,
      prompt: string(input, "prompt"),
      result: text ?? string(output, "result", "text", "content"),
      code: number(output, "status", "code"),
    }),
    think: ({ call, text }) => ({ type: "plain_text", label: call.title, icon: "brain", text }),
    switch_mode: ({ call, text }) => ({
      type: "plain_text",
      label: call.title,
      icon: "sparkles",
      text,
    }),
  } satisfies Record<string, KindDetail>),
);

/**
 * The row for a tool call whose transformers set no detail, read from the call's ACP `kind`,
 * `rawInput`, `rawOutput`, `content` and `locations` the way the ACP spec defines them.
 */
export function standardToolCallDetail(call: AcpToolCallSnapshot): ProviderToolCallDetail {
  const parts: ToolCallParts = {
    call,
    input: record(call.input),
    output: record(call.output),
    text: contentText(call.content),
  };
  const kindDetail = call.kind === undefined ? undefined : KIND_DETAILS.get(call.kind);
  if (kindDetail) return kindDetail(parts);
  if (call.name?.toLowerCase().includes("edit")) return editDetail(parts);
  // Raw input or output is the most a client can show for a tool it does not know.
  if (parts.text !== undefined && call.input === null && call.output === null) {
    return { type: "plain_text", label: call.title, icon: "wrench", text: parts.text };
  }
  return { type: "unknown", input: call.input, output: call.output };
}

function editDetail({ call, input, text }: ToolCallParts): ProviderToolCallDetail {
  const diff = contentDiff(call.content);
  const filePath =
    diff?.path ?? string(input, "filePath", "path", "file") ?? call.locations[0] ?? "";
  if (call.kind === "delete") {
    return {
      type: "edit",
      filePath,
      oldString: diff?.oldText ?? fileText(input, "oldText"),
      newString: "",
      unifiedDiff: text,
    };
  }
  return {
    type: "edit",
    filePath,
    oldString: diff?.oldText ?? fileText(input, "oldString", "oldText"),
    newString: diff?.newText ?? fileText(input, "newString", "newText"),
    unifiedDiff: string(input, "unifiedDiff") ?? text,
  };
}

function shellCommand(input: JsonRecord): string | undefined {
  const command = string(input, "command");
  if (!command) return undefined;
  const args = Array.isArray(input.args)
    ? input.args.filter((arg): arg is string => typeof arg === "string")
    : [];
  return args.length > 0 ? `${command} ${args.join(" ")}` : command;
}

function contentText(content: JsonValue | undefined): string | undefined {
  const parts = contentBlocks(content).flatMap((block) => {
    if (block.type !== "content") return [];
    const body = record(block.content ?? null);
    return body.type === "text" && typeof body.text === "string" && body.text.length > 0
      ? [body.text]
      : [];
  });
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function contentDiff(
  content: JsonValue | undefined,
): { path?: string; oldText?: string; newText?: string } | undefined {
  const diff = contentBlocks(content).find((block) => block.type === "diff");
  if (!diff) return undefined;
  return {
    path: string(diff, "path"),
    oldText: typeof diff.oldText === "string" ? diff.oldText : undefined,
    newText: typeof diff.newText === "string" ? diff.newText : undefined,
  };
}

function contentBlocks(content: JsonValue | undefined): JsonRecord[] {
  return Array.isArray(content) ? content.map((block) => record(block)) : [];
}

function record(value: JsonValue): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

function string(value: JsonRecord, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const entry = value[key];
    if (typeof entry === "string" && entry.trim().length > 0) return entry;
  }
  return undefined;
}

/** File text is kept as written: whitespace or an empty string is the edit itself. */
function fileText(value: JsonRecord, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const entry = value[key];
    if (typeof entry === "string") return entry;
  }
  return undefined;
}

function number(value: JsonRecord, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const entry = value[key];
    if (typeof entry === "number" && Number.isFinite(entry)) return entry;
  }
  return undefined;
}
