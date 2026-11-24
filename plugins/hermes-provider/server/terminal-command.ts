import type { AcpToolCallSnapshot, AcpTransformer } from "@getpaseo/plugin/server/acp";
import { z } from "zod";

const commandInput = z.object({ command: z.string() });
const startText = z.tuple([
  z.object({
    type: z.literal("content"),
    content: z.object({ type: z.literal("text"), text: z.string().startsWith("$ ") }),
  }),
]);

// Hermes titles a terminal call with a summary (`terminal: git status + 2 commands`) and sends the
// command only as `$ <command>` text in the call's first update; the completed update replaces that
// text with the result. Keeping the command as the call's input lets Paseo's Shell row show it.
// When Hermes sends neither shape, the call passes through and the row shows Hermes's title.
export const terminalCommand: AcpTransformer = {
  toolCall(call, { previous }) {
    if (call.kind !== "execute" || commandInput.safeParse(call.input).success) return call;
    const command =
      commandFromStartText(call) ?? commandInput.safeParse(previous?.input).data?.command;
    if (command === undefined) return call;
    const input = typeof call.input === "object" && !Array.isArray(call.input) ? call.input : null;
    return { ...call, input: { ...input, command } };
  },
};

function commandFromStartText(call: AcpToolCallSnapshot): string | undefined {
  return startText.safeParse(call.content).data?.[0].content.text.slice("$ ".length);
}
