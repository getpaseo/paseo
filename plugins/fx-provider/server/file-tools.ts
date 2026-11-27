import type { AcpToolCallSnapshot, AcpTransformer } from "@getpaseo/plugin/server/acp";

type ToolInput = AcpToolCallSnapshot["input"];

// fx names its file arguments for the model (`path`, `old_string`), so its file tools need the
// argument names Paseo's edit rows read. The adapter reapplies this to each update of a call.
export const fileToolTransformer: AcpTransformer = {
  toolCall(toolCall) {
    const input = toEditRowInput(toolCall.name, toolCall.input);
    return input ? { ...toolCall, input } : toolCall;
  },
};

function toEditRowInput(tool: string | undefined, input: ToolInput): ToolInput | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  if (typeof input.path !== "string") return null;
  if (tool === "write_file") return { filePath: input.path, newString: input.content ?? null };
  if (tool === "edit_file") {
    return {
      filePath: input.path,
      oldString: input.old_string ?? null,
      newString: input.new_string ?? null,
    };
  }
  return null;
}
