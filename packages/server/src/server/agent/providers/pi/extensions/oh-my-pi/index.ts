import { z } from "zod";
import { extractTextFromToolResult } from "../../tool-call-mapper.js";
import type { PiExtension } from "../contract.js";

const TaskArgs = z
  .object({
    agent: z.string().optional().catch(undefined),
    task: z.string().optional().catch(undefined),
  })
  .passthrough();
const XdevDetails = z.object({
  tool: z.string().trim().min(1),
  mode: z.literal("execute"),
  args: z.unknown().optional(),
  inner: z.unknown().optional(),
});
const nonEmpty = (value: string | undefined) => value?.trim() || undefined;

export const ohMyPi: PiExtension = {
  id: "oh-my-pi",
  createSession: () => ({
    mapToolCall(call) {
      if (call.toolName === "task") {
        const args = TaskArgs.safeParse(call.args);
        return {
          detail: {
            type: "sub_agent",
            subAgentType: args.success ? nonEmpty(args.data.agent) : undefined,
            description: args.success ? nonEmpty(args.data.task) : undefined,
            log: extractTextFromToolResult(call.result)?.trim() ?? "",
          },
        };
      }
      if (
        call.toolName !== "write" ||
        !call.result ||
        typeof call.result === "string" ||
        !("xdev" in (call.result.details ?? {}))
      )
        return undefined;
      const parsed = XdevDetails.safeParse(call.result.details?.xdev);
      if (!parsed.success)
        return { detail: { type: "unknown", input: call.args, output: call.result } };
      return {
        name: parsed.data.tool,
        detail: {
          type: "unknown",
          input: parsed.data.args ?? null,
          output: { ...call.result, details: parsed.data.inner ?? null },
        },
      };
    },
  }),
};
