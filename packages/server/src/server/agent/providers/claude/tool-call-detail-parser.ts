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
  toolDetailBranchByName,
} from "../tool-call-detail-primitives.js";

const ClaudeKnownToolDetailSchema = z.union([
  toolDetailBranchByName("Bash", ToolShellInputSchema, ToolShellOutputSchema, toShellToolDetail),
  toolDetailBranchByName("bash", ToolShellInputSchema, ToolShellOutputSchema, toShellToolDetail),
  toolDetailBranchByName("shell", ToolShellInputSchema, ToolShellOutputSchema, toShellToolDetail),
  toolDetailBranchByName("exec_command", ToolShellInputSchema, ToolShellOutputSchema, toShellToolDetail),
  toolDetailBranchByName("Read", ToolReadInputSchema, ToolReadOutputSchema, toReadToolDetail),
  toolDetailBranchByName("read", ToolReadInputSchema, ToolReadOutputSchema, toReadToolDetail),
  toolDetailBranchByName("read_file", ToolReadInputSchema, ToolReadOutputSchema, toReadToolDetail),
  toolDetailBranchByName("view_file", ToolReadInputSchema, ToolReadOutputSchema, toReadToolDetail),
  toolDetailBranchByName("Write", ToolWriteInputSchema, ToolWriteOutputSchema, toWriteToolDetail),
  toolDetailBranchByName("write", ToolWriteInputSchema, ToolWriteOutputSchema, toWriteToolDetail),
  toolDetailBranchByName("write_file", ToolWriteInputSchema, ToolWriteOutputSchema, toWriteToolDetail),
  toolDetailBranchByName("create_file", ToolWriteInputSchema, ToolWriteOutputSchema, toWriteToolDetail),
  toolDetailBranchByName("Edit", ToolEditInputSchema, ToolEditOutputSchema, toEditToolDetail),
  toolDetailBranchByName("MultiEdit", ToolEditInputSchema, ToolEditOutputSchema, toEditToolDetail),
  toolDetailBranchByName("multi_edit", ToolEditInputSchema, ToolEditOutputSchema, toEditToolDetail),
  toolDetailBranchByName("edit", ToolEditInputSchema, ToolEditOutputSchema, toEditToolDetail),
  toolDetailBranchByName("apply_patch", ToolEditInputSchema, ToolEditOutputSchema, toEditToolDetail),
  toolDetailBranchByName("apply_diff", ToolEditInputSchema, ToolEditOutputSchema, toEditToolDetail),
  toolDetailBranchByName("str_replace_editor", ToolEditInputSchema, ToolEditOutputSchema, toEditToolDetail),
  toolDetailBranchByName("WebSearch", ToolSearchInputSchema, z.unknown(), (input) =>
    toSearchToolDetail(input)
  ),
  toolDetailBranchByName("web_search", ToolSearchInputSchema, z.unknown(), (input) =>
    toSearchToolDetail(input)
  ),
  toolDetailBranchByName("search", ToolSearchInputSchema, z.unknown(), (input) =>
    toSearchToolDetail(input)
  ),
]);

export function deriveClaudeToolDetail(
  name: string,
  input: unknown,
  output: unknown
): ToolCallDetail | undefined {
  const parsed = ClaudeKnownToolDetailSchema.safeParse({
    name,
    input,
    output,
  });
  if (!parsed.success) {
    return undefined;
  }
  return parsed.data;
}
