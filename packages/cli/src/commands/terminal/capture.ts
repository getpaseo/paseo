import type { Command } from "commander";
import { renderError, toCommandError } from "../../output/render.js";
import {
  connectTerminalClient,
  resolveTerminalId,
  toTerminalCommandError,
  type TerminalCommandOptions,
} from "./shared.js";

export interface TerminalCaptureOptions extends TerminalCommandOptions {
  start?: string;
  end?: string;
  scrollback?: boolean;
  ansi?: boolean;
}

export async function runCaptureCommand(
  terminalId: string,
  _options: TerminalCaptureOptions,
  command: Command,
): Promise<void> {
  const options = command.optsWithGlobals() as TerminalCaptureOptions;

  try {
    const payload = await executeCaptureCommand(terminalId, options);
    if (options.json) {
      process.stdout.write(
        JSON.stringify(
          {
            terminalId: payload.terminalId,
            lines: payload.lines,
            totalLines: payload.totalLines,
          },
          null,
          2,
        ) + "\n",
      );
      return;
    }

    if (payload.lines.length > 0) {
      process.stdout.write(payload.lines.join("\n") + "\n");
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

async function executeCaptureCommand(
  terminalId: string,
  options: TerminalCaptureOptions,
): Promise<{ terminalId: string; lines: string[]; totalLines: number }> {
  const { client, close } = await connectTerminalClient(options.host);

  try {
    const resolvedId = await resolveTerminalId(client, terminalId);
    if (!resolvedId) {
      throw {
        code: "TERMINAL_NOT_FOUND",
        message: `No terminal found matching: ${terminalId}`,
        details: "Use `paseo terminal ls --all` to list available terminals.",
      };
    }

    const start = options.scrollback ? 0 : parseLineNumber("--start", options.start);
    const end = parseLineNumber("--end", options.end);

    return await client.terminals.ref(resolvedId).capture({
      ...(start === undefined ? {} : { start }),
      ...(end === undefined ? {} : { end }),
      stripAnsi: !options.ansi,
    });
  } catch (err) {
    throw toTerminalCommandError("TERMINAL_CAPTURE_FAILED", "capture terminal output", err);
  } finally {
    await close().catch(() => {});
  }
}

function parseLineNumber(flag: string, value?: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) {
    throw {
      code: "INVALID_LINE_NUMBER",
      message: `Invalid ${flag} value: ${value}`,
      details: "Use an integer line number.",
    };
  }
  return parsed;
}
