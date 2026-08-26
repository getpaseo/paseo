export interface StrippedReadContent {
  content: string;
  startLine?: number;
}

const READ_GUTTER_LINE = /^\s*(\d+)(?:\t|:\s?)(.*)$/;

export function stripReadLineNumberGutter(
  content: string | undefined,
): StrippedReadContent | undefined {
  if (typeof content !== "string" || content.length === 0) {
    return undefined;
  }

  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const stripped: string[] = [];
  let nonEmpty = 0;
  let matched = 0;
  let startLine: number | undefined;
  let prevNumber: number | undefined;
  let sequential = true;
  let firstNonEmptyMatched = false;
  let sawNonEmpty = false;

  for (const line of lines) {
    if (line.length === 0) {
      stripped.push(line);
      continue;
    }
    nonEmpty += 1;
    const match = line.match(READ_GUTTER_LINE);
    if (!match) {
      if (!sawNonEmpty) {
        return undefined;
      }
      stripped.push(line);
      sawNonEmpty = true;
      continue;
    }
    if (!sawNonEmpty) {
      firstNonEmptyMatched = true;
    }
    sawNonEmpty = true;
    matched += 1;
    const lineNumber = Number.parseInt(match[1], 10);
    if (startLine === undefined) {
      startLine = lineNumber;
    }
    if (prevNumber !== undefined && lineNumber !== prevNumber + 1) {
      sequential = false;
    }
    prevNumber = lineNumber;
    stripped.push(match[2]);
  }

  if (!firstNonEmptyMatched || !sequential || nonEmpty === 0) {
    return undefined;
  }
  if (matched / nonEmpty < 0.5) {
    return undefined;
  }

  return { content: stripped.join("\n"), startLine };
}
