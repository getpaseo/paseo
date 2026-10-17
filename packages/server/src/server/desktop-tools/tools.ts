import { z } from "zod";
import { DesktopCommandSchema, type DesktopCommand } from "@getpaseo/protocol/desktop-capture";
import type { DesktopToolsBroker } from "./broker.js";
import type { PaseoToolConfig, PaseoToolResult } from "../agent/tools/types.js";

export function registerDesktopTools(input: {
  registerTool(
    name: string,
    config: PaseoToolConfig,
    handler: (value: unknown) => Promise<PaseoToolResult>,
  ): void;
  broker?: DesktopToolsBroker;
  agentId?: string;
  isCaptureAgent(id: string): boolean;
}) {
  const { broker, agentId } = input;
  if (!broker || !agentId || !input.isCaptureAgent(agentId)) return;
  for (const schema of DesktopCommandSchema.options) {
    const { command: commandSchema, ...shape } = schema.shape;
    const command = commandSchema.value;
    input.registerTool(
      `desktop_${command}`,
      {
        title: `Mac: ${command}`,
        description:
          "Use the captured Mac. Coordinates are global screen points. Only one agent controls this Mac at a time. Plan mode permits screenshot and accessibility only. Call desktop_release when finished. Never replay an action whose outcome is unknown.",
        inputSchema: shape,
      },
      async (value) => {
        const parsed: DesktopCommand = DesktopCommandSchema.parse({
          ...z.record(z.string(), z.unknown()).parse(value),
          command,
        });
        const result = await broker.execute(agentId, parsed);
        if (typeof result.png === "string")
          return {
            content: [
              { type: "image", mimeType: "image/png", data: result.png },
              { type: "text", text: JSON.stringify({ ...result, png: undefined }) },
            ],
          };
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      },
    );
  }
  input.registerTool(
    "desktop_release",
    { description: "Release the Mac so another agent can control it.", inputSchema: {} },
    async () => {
      broker.release(agentId);
      return { content: [{ type: "text", text: "Released" }] };
    },
  );
}
