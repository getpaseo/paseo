import { z } from "zod";
import type { PiExtension } from "../contract.js";

const Args = z
  .object({
    tool: z.string().optional().catch(undefined),
    server: z.string().optional().catch(undefined),
  })
  .passthrough();
const Details = z
  .object({
    server: z.string().optional().catch(undefined),
    tool: z.string().optional().catch(undefined),
  })
  .passthrough();
const nonEmpty = (value: string | undefined) => value?.trim() || undefined;

export const piMcpAdapter: PiExtension = {
  id: "pi-mcp-adapter",
  createSession: () => ({
    mapToolCall(call) {
      if (call.toolName !== "mcp") return undefined;
      if (call.result && typeof call.result !== "string") {
        const details = Details.safeParse(call.result.details);
        if (details.success) {
          const server = nonEmpty(details.data.server);
          const tool = nonEmpty(details.data.tool);
          if (server && tool) return { name: `${server}.${tool}` };
        }
      }
      const args = Args.safeParse(call.args);
      if (!args.success) return undefined;
      const tool = nonEmpty(args.data.tool);
      const server = nonEmpty(args.data.server);
      if (tool && server)
        return {
          name: `${server}.${tool.startsWith(`${server}_`) ? tool.slice(server.length + 1) : tool}`,
        };
      if (tool) {
        const [prefix, ...rest] = tool.split("_");
        if (prefix && rest.length > 0) return { name: `${prefix}.${rest.join("_")}` };
      }
      return undefined;
    },
  }),
};
