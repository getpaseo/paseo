import type { Command } from "commander";
import { renderError, toCommandError } from "../../output/render.js";
import {
  connectTerminalClient,
  resolveTerminalId,
  toTerminalCommandError,
  type TerminalCommandOptions,
} from "./shared.js";

export interface TerminalSendKeysOptions extends TerminalCommandOptions {
  literal?: boolean;
}

export async function runSendKeysCommand(
  terminalId: string,
  keys: string[],
  _options: TerminalSendKeysOptions,
  command: Command,
): Promise<void> {
  const options = command.optsWithGlobals() as TerminalSendKeysOptions;

  try {
    const payload = await executeSendKeysCommand(terminalId, keys, options);
    if (options.json) {
      process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    }
  } catch (err) {
    const output = renderError(toCommandError(err), {
      format: options.json ? "json" : "table",
      noColor: options.color === false,
    });
    process.stderr.write(output + "\n");
    process.exit(1);
  }
}

async function executeSendKeysCommand(
  terminalId: string,
  keys: string[],
  options: TerminalSendKeysOptions,
): Promise<{ terminalId: string; keysSent: number }> {
  const { client } = await connectTerminalClient(options.host);

  try {
    const resolvedId = await resolveTerminalId(client, terminalId);
    if (!resolvedId) {
      throw {
        code: "TERMINAL_NOT_FOUND",
        message: `No terminal found matching: ${terminalId}`,
        details: "Use `hubcode terminal ls --all` to list available terminals.",
      };
    }

    const data = keys.map((key) => resolveKeyToken(key, options.literal === true)).join("");
    client.sendTerminalInput(resolvedId, { type: "input", data });

    return {
      terminalId: resolvedId,
      keysSent: data.length,
    };
  } catch (err) {
    throw toTerminalCommandError("TERMINAL_SEND_KEYS_FAILED", "send terminal keys", err);
  } finally {
    await client.close().catch(() => {});
  }
}

function resolveKeyToken(key: string, literal: boolean): string {
  if (literal) {
    return key;
  }

  switch (key) {
    case "Enter":
      return "\r";
    case "Tab":
      return "\t";
    case "Escape":
      return "\u001b";
    case "Space":
      return " ";
    case "BSpace":
      return "\u007f";
    case "C-c":
      return "\u0003";
    case "C-d":
      return "\u0004";
    case "C-z":
      return "\u001a";
    case "C-l":
      return "\u000c";
    case "C-a":
      return "\u0001";
    case "C-e":
      return "\u0005";
    default:
      return key;
  }
}
