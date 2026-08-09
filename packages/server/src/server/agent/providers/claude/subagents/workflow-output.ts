import fs from "node:fs";

const MAX_WORKFLOW_OUTPUT_BYTES = 1024 * 1024;
const MAX_WORKFLOW_RESULT_CHARS = 100_000;

export function readClaudeWorkflowResultFile(outputFile: string): string | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(outputFile, "r");
    const buffer = Buffer.alloc(MAX_WORKFLOW_OUTPUT_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = fs.readSync(descriptor, buffer, bytesRead, buffer.length - bytesRead, null);
      if (count === 0) break;
      bytesRead += count;
    }
    if (bytesRead > MAX_WORKFLOW_OUTPUT_BYTES) return undefined;
    return parseClaudeWorkflowResult(buffer.subarray(0, bytesRead).toString("utf8"));
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

export function parseClaudeWorkflowResult(contents: string): string | undefined {
  if (Buffer.byteLength(contents, "utf8") > MAX_WORKFLOW_OUTPUT_BYTES) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return undefined;
  }
  const record = toRecord(parsed);
  return record && Object.hasOwn(record, "result")
    ? formatClaudeWorkflowResult(record.result)
    : undefined;
}

export function formatClaudeWorkflowResult(result: unknown): string | undefined {
  const unwrapped = unwrapSingleValue(result);
  let text: string | undefined;
  if (typeof unwrapped === "string") {
    text = unwrapped.trim();
  } else if (typeof unwrapped === "number" || typeof unwrapped === "boolean") {
    text = String(unwrapped);
  } else if (unwrapped !== null && unwrapped !== undefined) {
    try {
      const json = JSON.stringify(unwrapped, null, 2);
      if (json) text = `\`\`\`json\n${json}\n\`\`\``;
    } catch {
      return undefined;
    }
  }

  if (!text) return undefined;
  return text.length <= MAX_WORKFLOW_RESULT_CHARS
    ? text
    : `${text.slice(0, MAX_WORKFLOW_RESULT_CHARS)}\n\n…`;
}

function unwrapSingleValue(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < 8; depth += 1) {
    const record = toRecord(current);
    if (!record) return current;
    const keys = Object.keys(record);
    if (keys.length !== 1) return current;
    current = record[keys[0]];
  }
  return current;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
