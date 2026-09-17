import type { AcpTransformer } from "@getpaseo/plugin/server/acp";
import { z } from "zod";

const vendorEditInputSchema = z.object({
  path: z.string(),
  before: z.string(),
  after: z.string(),
});

export const vendorEditTransformer: AcpTransformer = {
  toolCall(toolCall) {
    if (toolCall.name !== "vendor_file_edit") return toolCall;
    const input = vendorEditInputSchema.safeParse(toolCall.input);
    if (!input.success) return toolCall;
    return {
      ...toolCall,
      kind: "edit",
      input: {
        filePath: input.data.path,
        oldString: input.data.before,
        newString: input.data.after,
      },
    };
  },
};
