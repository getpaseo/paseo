import type { ToolCallDetail } from "@server/server/agent/agent-sdk-types";

const SHELL_FILE_COMMANDS = new Set([
  "cat",
  "bat",
  "less",
  "more",
  "head",
  "tail",
  "wc",
  "nl",
  "tac",
  "od",
  "xxd",
  "file",
  "stat",
  "column",
  "md5",
  "md5sum",
  "sha1sum",
  "sha256sum",
  "shasum",
]);

const SHELL_OPERATOR_PATTERN = /[|><&;`$()]/;
const SHORT_FLAG_PATTERN = /^-[a-zA-Z]$/;

function extractFromShellCommand(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed || SHELL_OPERATOR_PATTERN.test(trimmed)) {
    return null;
  }
  const tokens = trimmed.split(/\s+/);
  if (tokens.length < 2) {
    return null;
  }
  if (!SHELL_FILE_COMMANDS.has(tokens[0])) {
    return null;
  }
  const last = tokens[tokens.length - 1];
  if (last.startsWith("-")) {
    return null;
  }
  if (tokens.length > 2) {
    const prev = tokens[tokens.length - 2];
    if (!prev.startsWith("-")) {
      const prevPrev = tokens[tokens.length - 3];
      if (!prevPrev || !SHORT_FLAG_PATTERN.test(prevPrev)) {
        return null;
      }
    }
  }
  return last;
}

export function extractToolCallFilePath(detail: ToolCallDetail | undefined): string | null {
  if (!detail) {
    return null;
  }
  switch (detail.type) {
    case "read":
    case "edit":
    case "write":
      return detail.filePath || null;
    case "shell":
      return extractFromShellCommand(detail.command);
    default:
      return null;
  }
}
