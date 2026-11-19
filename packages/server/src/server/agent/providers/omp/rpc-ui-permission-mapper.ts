import type {
  AgentMetadata,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentProvider,
  ToolCallDetail,
} from "../../agent-sdk-types.js";
import type { OmpRuntimeEvent } from "./rpc-types.js";

const OMP_PROVIDER = "omp";
const OMP_RPC_UI_TOOL_APPROVAL_METADATA = "omp_rpc_ui_tool_approval";
const TOOL_APPROVAL_APPROVE_VALUE = "Approve";
// OMP labels the approve-this-call choice "Approve Once" when it also offers grants that remember
// more. A grant can then be labeled "Approve", so "Approve" is the one-call choice only without it.
const TOOL_APPROVAL_ONCE_VALUE = "Approve Once";
const TOOL_APPROVAL_DENY_VALUE = "Deny";
// Session and grant choices OMP offers beside the one-call approval, e.g. "Approve write for this session".
const TOOL_APPROVAL_EXTRA_CHOICE = /^(?:Always )?Approve\b/;
const TOOL_APPROVAL_EXTRA_ACTION_PREFIX = "approve-option-";
const TOOL_TITLE_PREFIX = "Allow tool: ";

export type OmpRpcUiPermissionClassification =
  | { kind: "tool"; request: AgentPermissionRequest }
  | { kind: "passthrough" };

type ExtensionUiRequestEvent = Extract<OmpRuntimeEvent, { type: "extension_ui_request" }>;

interface ToolApprovalDescriptor {
  toolName: "bash" | "edit" | "write";
  args: AgentMetadata;
  detail: ToolCallDetail;
  description?: string;
  choices: ToolApprovalChoices;
}

interface ToolApprovalChoices {
  approveValue: string;
  extraValues: string[];
}

export function classifyOmpRpcUiPermissionRequest(
  event: ExtensionUiRequestEvent,
  options: { provider?: AgentProvider } = {},
): OmpRpcUiPermissionClassification {
  const descriptor = parseToolApprovalDescriptor(event);
  if (!descriptor) {
    return { kind: "passthrough" };
  }

  const provider = options.provider ?? OMP_PROVIDER;
  const { approveValue, extraValues } = descriptor.choices;
  const extraActions = extraValues.map((value, index) => ({
    id: `${TOOL_APPROVAL_EXTRA_ACTION_PREFIX}${index}`,
    label: value,
    behavior: "allow" as const,
    variant: "secondary" as const,
  }));
  return {
    kind: "tool",
    request: {
      id: event.id,
      provider,
      name: descriptor.toolName,
      kind: "tool",
      title: `Allow tool: ${descriptor.toolName}`,
      ...(descriptor.description ? { description: descriptor.description } : {}),
      detail: descriptor.detail,
      actions: [
        {
          id: "deny",
          label: TOOL_APPROVAL_DENY_VALUE,
          behavior: "deny",
          variant: "danger",
          intent: "dismiss",
        },
        {
          id: "approve",
          label: approveValue,
          behavior: "allow",
          variant: "primary",
        },
        ...extraActions,
      ],
      metadata: {
        extensionUiMethod: "select",
        toolApproval: OMP_RPC_UI_TOOL_APPROVAL_METADATA,
        toolName: descriptor.toolName,
        toolArgs: descriptor.args,
        approveValue,
        denyValue: TOOL_APPROVAL_DENY_VALUE,
      },
    },
  };
}

export function mapOmpRpcUiPermissionRequest(
  event: ExtensionUiRequestEvent,
  options: { provider?: AgentProvider } = {},
): AgentPermissionRequest | null {
  const classification = classifyOmpRpcUiPermissionRequest(event, options);
  return classification.kind === "tool" ? classification.request : null;
}

export function buildOmpRpcUiPermissionResponse(
  request: AgentPermissionRequest,
  response: AgentPermissionResponse,
): { value?: string; confirmed?: boolean; cancelled?: boolean } | null {
  if (
    request.kind !== "tool" ||
    request.metadata?.toolApproval !== OMP_RPC_UI_TOOL_APPROVAL_METADATA
  ) {
    return null;
  }

  const approveValue = readString(request.metadata.approveValue) ?? TOOL_APPROVAL_APPROVE_VALUE;
  const denyValue = readString(request.metadata.denyValue) ?? TOOL_APPROVAL_DENY_VALUE;
  if (response.behavior !== "allow") {
    return { value: denyValue };
  }
  // Each extra choice's action label is the exact select value OMP offered.
  const selectedExtraChoice = request.actions?.find(
    (action) =>
      action.id === response.selectedActionId &&
      action.id.startsWith(TOOL_APPROVAL_EXTRA_ACTION_PREFIX),
  );
  return { value: selectedExtraChoice?.label ?? approveValue };
}

function parseToolApprovalDescriptor(
  event: ExtensionUiRequestEvent,
): ToolApprovalDescriptor | null {
  const choices = event.method === "select" ? readToolApprovalChoices(event.options) : null;
  if (!choices) {
    return null;
  }
  const title = readString(event.title);
  if (!title) {
    return null;
  }

  const firstLineBreak = title.search(/\r?\n/);
  const firstLine = (firstLineBreak < 0 ? title : title.slice(0, firstLineBreak)).trim();
  if (!firstLine.startsWith(TOOL_TITLE_PREFIX)) {
    return null;
  }
  const rawToolName = firstLine.slice(TOOL_TITLE_PREFIX.length).trim();
  const body = firstLineBreak < 0 ? "" : title.slice(firstLineBreak).replace(/^\r?\n/, "");
  const bodyLines = body.split(/\r?\n/);

  const parsed = parseToolApprovalBody(rawToolName, body, bodyLines);
  return parsed ? { ...parsed, choices } : null;
}

function parseToolApprovalBody(
  rawToolName: string,
  body: string,
  bodyLines: string[],
): Omit<ToolApprovalDescriptor, "choices"> | null {
  switch (rawToolName) {
    case "bash":
      return parseBashApproval(body);
    case "edit":
      return parseEditApproval(bodyLines);
    case "write":
      return parseWriteApproval(bodyLines);
    default:
      return null;
  }
}

function parseBashApproval(body: string): Omit<ToolApprovalDescriptor, "choices"> | null {
  const match = /(?:^|\r?\n)[\t ]*Command:[\t ]?(.*)$/s.exec(body);
  const command = match?.[1];
  if (!command) {
    return null;
  }
  return {
    toolName: "bash",
    args: { command },
    description: `Command: ${command}`,
    detail: { type: "shell", command },
  };
}

function parseEditApproval(lines: string[]): Omit<ToolApprovalDescriptor, "choices"> | null {
  const filePath = readPrefixedValue(lines, "File:");
  if (!filePath) {
    return null;
  }
  return {
    toolName: "edit",
    args: { path: filePath },
    description: `File: ${filePath}`,
    detail: { type: "edit", filePath },
  };
}

function parseWriteApproval(lines: string[]): Omit<ToolApprovalDescriptor, "choices"> | null {
  const pathLineIndex = lines.findIndex((line) => line.trim().startsWith("Path:"));
  if (pathLineIndex < 0) {
    return null;
  }
  const filePath = stripPrefix(lines[pathLineIndex], "Path:")?.trim();
  if (!filePath) {
    return null;
  }

  const contentLineIndex = lines.findIndex(
    (line, index) => index > pathLineIndex && line.trim() === "Content:",
  );
  if (contentLineIndex < 0) {
    return null;
  }
  const content = lines.slice(contentLineIndex + 1).join("\n");
  return {
    toolName: "write",
    args: { path: filePath, content },
    description: `Path: ${filePath}`,
    detail: { type: "write", filePath, content },
  };
}

function readToolApprovalChoices(options: unknown): ToolApprovalChoices | null {
  if (!Array.isArray(options) || !options.every((option) => typeof option === "string")) {
    return null;
  }
  const labels = options as string[];
  if (
    labels.at(-1) !== TOOL_APPROVAL_DENY_VALUE ||
    labels.indexOf(TOOL_APPROVAL_DENY_VALUE) !== labels.length - 1
  ) {
    return null;
  }
  const approveValue = [TOOL_APPROVAL_ONCE_VALUE, TOOL_APPROVAL_APPROVE_VALUE].find((value) =>
    labels.includes(value),
  );
  if (!approveValue) {
    return null;
  }
  const extraValues = labels.slice(0, -1).filter((label) => label !== approveValue);
  if (!extraValues.every((label) => TOOL_APPROVAL_EXTRA_CHOICE.test(label))) {
    return null;
  }
  return { approveValue, extraValues };
}

function readPrefixedValue(lines: readonly string[], prefix: string): string | null {
  for (const line of lines) {
    const value = stripPrefix(line, prefix)?.trim();
    if (value) {
      return value;
    }
  }
  return null;
}

function stripPrefix(line: string | undefined, prefix: string): string | null {
  const trimmed = line?.trim();
  return trimmed?.startsWith(prefix) ? trimmed.slice(prefix.length) : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
