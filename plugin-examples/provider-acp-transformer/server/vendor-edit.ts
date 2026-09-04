import type { AcpTransformer } from "@getpaseo/plugin/acp";

export const vendorEditTransformer: AcpTransformer = {
  toolCall(toolCall) {
    if (toolCall.name !== "vendor_file_edit") return toolCall;
    const input = asRecord(toolCall.input);
    return {
      ...toolCall,
      kind: "edit",
      input: {
        filePath: typeof input.path === "string" ? input.path : "",
        oldString: typeof input.before === "string" ? input.before : "",
        newString: typeof input.after === "string" ? input.after : "",
      },
    };
  },
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
