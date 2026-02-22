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

const ClaudeToolDetailPass2Schema = z.union([
  toolDetailBranchByName("Bash", ToolShellInputSchema, ToolShellOutputSchema, toShellToolDetail),
  toolDetailBranchByName("bash", ToolShellInputSchema, ToolShellOutputSchema, toShellToolDetail),
  toolDetailBranchByName("shell", ToolShellInputSchema, ToolShellOutputSchema, toShellToolDetail),
  toolDetailBranchByName("exec_command", ToolShellInputSchema, ToolShellOutputSchema, toShellToolDetail),
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
  toolDetailBranchByName("write_file", ToolWriteInputSchema, ToolWriteOutputSchema, toWriteToolDetail),
  toolDetailBranchByName("create_file", ToolWriteInputSchema, ToolWriteOutputSchema, toWriteToolDetail),
  toolDetailBranchByName("Edit", ToolEditInputSchema, ToolEditOutputSchema, toEditToolDetail),
  toolDetailBranchByName("MultiEdit", ToolEditInputSchema, ToolEditOutputSchema, toEditToolDetail),
  toolDetailBranchByName("multi_edit", ToolEditInputSchema, ToolEditOutputSchema, toEditToolDetail),
  toolDetailBranchByName("edit", ToolEditInputSchema, ToolEditOutputSchema, toEditToolDetail),
  toolDetailBranchByName("apply_patch", ToolEditInputSchema, ToolEditOutputSchema, toEditToolDetail),
  toolDetailBranchByName("apply_diff", ToolEditInputSchema, ToolEditOutputSchema, toEditToolDetail),
  toolDetailBranchByName(
    "str_replace_editor",
    ToolEditInputSchema,
    ToolEditOutputSchema,
    toEditToolDetail
  ),
  toolDetailBranchByName("WebSearch", ToolSearchInputSchema, z.unknown(), (input) =>
    toSearchToolDetail(input)
  ),
  toolDetailBranchByName("web_search", ToolSearchInputSchema, z.unknown(), (input) =>
    toSearchToolDetail(input)
  ),
  toolDetailBranchByName("search", ToolSearchInputSchema, z.unknown(), (input) =>
    toSearchToolDetail(input)
  ),
  toolDetailBranchByName("Glob", ToolSearchInputSchema, z.unknown(), (input) =>
    toSearchToolDetail(input)
  ),
  toolDetailBranchByName("glob", ToolSearchInputSchema, z.unknown(), (input) =>
    toSearchToolDetail(input)
  ),
  ClaudeSpeakToolDetailSchema,
]);

export function deriveClaudeToolDetail(
  name: string,
  input: unknown,
  output: unknown
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
