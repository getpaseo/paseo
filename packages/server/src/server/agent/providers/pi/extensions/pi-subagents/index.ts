import { z } from "zod";
import { extractTextFromToolResult } from "../../tool-call-mapper.js";
import type { PiExtension } from "../contract.js";

const Args = z
  .object({
    agent: z.string().optional().catch(undefined),
    task: z.string().optional().catch(undefined),
    action: z.unknown().optional(),
  })
  .passthrough();
const nonEmpty = (value: string | undefined) => value?.trim() || undefined;

export const piSubagents: PiExtension = {
  id: "pi-subagents",
  createSession: () => ({
    mapToolCall(call) {
      if (call.toolName !== "subagent") return undefined;
      const args = Args.safeParse(call.args);
      if (
        !args.success ||
        args.data.action !== undefined ||
        (!nonEmpty(args.data.agent) && !nonEmpty(args.data.task))
      )
        return undefined;
      return {
        detail: {
          type: "sub_agent",
          subAgentType: nonEmpty(args.data.agent),
          description: nonEmpty(args.data.task),
          log: extractTextFromToolResult(call.result)?.trim() ?? "",
        },
      };
    },
  }),
};
