import { z } from "zod";

import type { ToolCallDetail } from "../../agent-sdk-types.js";
import {
  ToolEditInputSchema,
  ToolEditOutputSchema,
  ToolReadInputSchema,
  ToolReadOutputSchema,
  ToolSearchInputSchema,
  ToolShellInputSchema,
  ToolShellOutputSchema,
  ToolWriteInputSchema,
  ToolWriteOutputSchema,
  toEditToolDetail,
  toReadToolDetail,
  toSearchToolDetail,
  toShellToolDetail,
  toWriteToolDetail,
  toolDetailBranchByToolName,
} from "../tool-call-detail-primitives.js";

const OpencodeKnownToolDetailSchema = z.union([
  toolDetailBranchByToolName("shell", ToolShellInputSchema, ToolShellOutputSchema, toShellToolDetail),
  toolDetailBranchByToolName("bash", ToolShellInputSchema, ToolShellOutputSchema, toShellToolDetail),
  toolDetailBranchByToolName("exec_command", ToolShellInputSchema, ToolShellOutputSchema, toShellToolDetail),
  toolDetailBranchByToolName("read", ToolReadInputSchema, ToolReadOutputSchema, toReadToolDetail),
  toolDetailBranchByToolName("read_file", ToolReadInputSchema, ToolReadOutputSchema, toReadToolDetail),
  toolDetailBranchByToolName("write", ToolWriteInputSchema, ToolWriteOutputSchema, toWriteToolDetail),
  toolDetailBranchByToolName("write_file", ToolWriteInputSchema, ToolWriteOutputSchema, toWriteToolDetail),
  toolDetailBranchByToolName("create_file", ToolWriteInputSchema, ToolWriteOutputSchema, toWriteToolDetail),
  toolDetailBranchByToolName("edit", ToolEditInputSchema, ToolEditOutputSchema, toEditToolDetail),
  toolDetailBranchByToolName("apply_patch", ToolEditInputSchema, ToolEditOutputSchema, toEditToolDetail),
  toolDetailBranchByToolName("apply_diff", ToolEditInputSchema, ToolEditOutputSchema, toEditToolDetail),
  toolDetailBranchByToolName("search", ToolSearchInputSchema, z.unknown(), (input) =>
    toSearchToolDetail(input)
  ),
  toolDetailBranchByToolName("web_search", ToolSearchInputSchema, z.unknown(), (input) =>
    toSearchToolDetail(input)
  ),
]);

export function deriveOpencodeToolDetail(
  toolName: string,
  input: unknown,
  output: unknown
): ToolCallDetail | undefined {
  const parsed = OpencodeKnownToolDetailSchema.safeParse({
    toolName,
    input,
    output,
  });
  if (!parsed.success) {
    return undefined;
  }
  return parsed.data;
}
