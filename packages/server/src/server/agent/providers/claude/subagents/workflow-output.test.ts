import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  formatClaudeWorkflowResult,
  parseClaudeWorkflowResult,
  readClaudeWorkflowResultFile,
} from "./workflow-output.js";

describe("Claude workflow output", () => {
  it("extracts the real single-report result without exposing provider internals", () => {
    const text = parseClaudeWorkflowResult(
      JSON.stringify({
        summary: "Inspect Paseo",
        result: { report: "What Paseo is\nA local-first coding-agent environment." },
        script: "SECRET WORKFLOW SOURCE",
        args: "SECRET ARGS",
        workflowProgress: [{ promptPreview: "SECRET CHILD PROMPT" }],
      }),
    );

    expect(text).toBe("What Paseo is\nA local-first coding-agent environment.");
    expect(text).not.toContain("SECRET");
  });

  it("formats a structured multi-field result as JSON", () => {
    expect(formatClaudeWorkflowResult({ status: "ok", files: 4 })).toBe(
      '```json\n{\n  "status": "ok",\n  "files": 4\n}\n```',
    );
  });

  it.each(["", "not json", "[]", '{"summary":"no result"}'])(
    "ignores malformed or result-free output %j",
    (contents) => {
      expect(parseClaudeWorkflowResult(contents)).toBeUndefined();
    },
  );

  it("rejects an oversized output file before parsing", () => {
    expect(parseClaudeWorkflowResult("x".repeat(1024 * 1024 + 1))).toBeUndefined();
  });

  it("ignores an unreadable output file", () => {
    expect(readClaudeWorkflowResultFile("/definitely/missing/workflow.output")).toBeUndefined();
  });

  it("reads at most one byte beyond the on-disk limit before rejecting", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "paseo-workflow-output-limit-"));
    const outputFile = path.join(directory, "workflow.output");
    try {
      writeFileSync(outputFile, "x".repeat(1024 * 1024 + 1), "utf8");
      expect(readClaudeWorkflowResultFile(outputFile)).toBeUndefined();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("bounds a large result", () => {
    const text = formatClaudeWorkflowResult("x".repeat(110_000));
    expect(text?.length).toBeLessThan(110_000);
    expect(text).toMatch(/…$/u);
  });
});
