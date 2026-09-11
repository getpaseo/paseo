import { i18n } from "@/i18n/i18next";
import { isAbsolutePath } from "@/utils/path";
import {
  readToolCallSummary,
  readToolCallSummaryFilePath,
} from "@getpaseo/protocol/tool-call-summary";
import type { ComponentType } from "react";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import type { ToolCallDisplayInput } from "@/utils/tool-call-display";
import { buildToolCallDisplayModel } from "@/utils/tool-call-display";
import { extractToolCallFilePath } from "@/utils/extract-tool-call-file-path";
import {
  hasMeaningfulToolCallDetail,
  isPendingToolCallDetail,
} from "@/utils/tool-call-detail-state";

type ToolCallStatus = "executing" | "running" | "completed" | "failed" | "canceled";
export type ToolCallPresentationIcon = ComponentType<{ size?: number; color?: string }>;

interface BuildToolCallPresentationInput {
  toolName: string;
  status: ToolCallStatus;
  error: unknown;
  detail?: ToolCallDetail;
  cwd?: string;
  metadata?: Record<string, unknown>;
  resolveIcon: ToolCallIconResolver;
}

export interface ToolCallPresentation {
  displayName: string;
  summary?: string;
  description?: string;
  inputLabel?: string;
  inputFilePath?: string;
  outputFilePath?: string;
  errorText?: string;
  icon: ToolCallPresentationIcon;
  isLoadingDetails: boolean;
  hasDetails: boolean;
  canOpenDetails: boolean;
  openFilePath: string | null;
  isPlan: boolean;
}

export type ToolCallIconResolver = (
  toolName: string,
  detail: ToolCallDetail | undefined,
) => ToolCallPresentationIcon;

function displayStatus(status: ToolCallStatus): ToolCallDisplayInput["status"] {
  return status === "executing" ? "running" : status;
}

function displayDetail(detail: ToolCallDetail | undefined): ToolCallDetail {
  return detail ?? { type: "unknown", input: null, output: null };
}

export function buildToolCallPresentation(
  input: BuildToolCallPresentationInput,
): ToolCallPresentation {
  const detailForDisplay = displayDetail(input.detail);
  const displayModel = buildToolCallDisplayModel({
    name: input.toolName,
    status: displayStatus(input.status),
    error: input.error ?? null,
    detail: detailForDisplay,
    metadata: input.metadata,
    cwd: input.cwd,
  });
  const isLoadingDetails = isPendingToolCallDetail({
    detail: input.detail,
    status: input.status,
    error: input.error,
  });
  const hasDetails =
    Boolean(input.error) ||
    Boolean(readToolCallSummary(input.metadata)) ||
    hasMeaningfulToolCallDetail(input.detail);

  const filePath = extractToolCallFilePath(input.detail);
  const inputLabel = buildInputLabel({
    detail: detailForDisplay,
    filePath,
    generated: readToolCallSummary(input.metadata, "input"),
    displayName: displayModel.displayName,
  });

  const toolCwd =
    detailForDisplay.type === "shell" ? (detailForDisplay.cwd ?? input.cwd) : input.cwd;
  function resolveSummaryPath(value: string | undefined): string | undefined {
    if (!value || !toolCwd || isAbsolutePath(value) || value.startsWith("~")) return value;
    return `${toolCwd.replace(/[\\/]$/, "")}/${value}`;
  }

  return {
    inputLabel,
    inputFilePath: resolveSummaryPath(
      readToolCallSummaryFilePath(input.metadata, "input") ?? filePath ?? undefined,
    ),
    outputFilePath: resolveSummaryPath(
      readToolCallSummaryFilePath(input.metadata) ?? filePath ?? undefined,
    ),
    displayName: displayModel.displayName,
    summary: displayModel.summary,
    description: readToolCallSummary(input.metadata),
    errorText: displayModel.errorText,
    icon: input.resolveIcon(input.toolName, input.detail),
    isLoadingDetails,
    hasDetails,
    canOpenDetails: hasDetails || isLoadingDetails,
    openFilePath: filePath,
    isPlan: input.detail?.type === "plan",
  };
}

interface InputLabelOptions {
  detail: ToolCallDetail;
  filePath: string | null;
  generated: string | undefined;
  displayName: string;
}

function buildInputLabel({
  detail,
  filePath,
  generated,
  displayName,
}: InputLabelOptions): string | undefined {
  if (detail.type === "shell") {
    const filename = filePath?.replace(/\\/g, "/").split("/").pop();
    if (filename && /^(cat|bat|less|more|head|tail|nl|tac)\s/.test(detail.command.trim())) {
      return i18n.t("message.toolCallLabels.readFile", { file: filename });
    }
    return generated ?? i18n.t("message.toolCallLabels.runShell");
  }
  if (detail.type === "unknown" || detail.type === "plain_text") {
    return generated ?? i18n.t("message.toolCallLabels.runTool", { tool: displayName });
  }
  return undefined;
}
