import { describe, expect, it } from "vitest";
import { isSummarizableToolCall } from "@getpaseo/protocol/tool-call-summary";
import { summaryCall, validateSummaryIds, SummaryResponseSchema } from "./prompt.js";
import type { ToolCallTimelineItem } from "@getpaseo/protocol/agent-types";

const shell: ToolCallTimelineItem = {
  type: "tool_call",
  callId: "call",
  name: "shell",
  status: "failed",
  error: "exit 1",
  detail: { type: "shell", command: "npm test", exitCode: 1, output: "failed" },
};
describe("summary prompt contract", () => {
  it("describes inputs without disclosing results to the input phase", () => {
    const call = summaryCall("input", { item: shell, timestamp: "now" }, "input");
    expect(call.phase).toBe("input");
    expect(call.input).toContain("npm test");
    expect(call.output).toBe("");
    expect(call.error).toBe("");
    expect(isSummarizableToolCall({ ...shell, status: "running" }, "input")).toBe(true);
  });
  it("only links full source paths that are named in the label", () => {
    const calls = [
      summaryCall(
        "one",
        {
          item: {
            ...shell,
            detail: {
              type: "shell",
              command: "cat /tmp/plans/keep-awake.md",
              output: "Plan content",
            },
          },
          timestamp: "now",
        },
        "input",
      ),
    ];
    const response = (filePath: string) => ({
      descriptions: [{ id: "one", description: "Read keep-awake.md", filePath }],
    });
    expect(validateSummaryIds(response("/tmp/plans/keep-awake.md"), calls)).toEqual(
      response("/tmp/plans/keep-awake.md"),
    );
    expect(() => validateSummaryIds(response("/invented/keep-awake.md"), calls)).toThrow(
      "supplied path",
    );
    expect(() => validateSummaryIds(response("keep-awake.md"), calls)).toThrow("supplied path");
  });
  it("enforces two to eight words for generated labels", () => {
    const calls = [summaryCall("one", { item: shell, timestamp: "now" })];
    const response = (description: string) => ({ descriptions: [{ id: "one", description }] });
    expect(validateSummaryIds(response("Read keep-awake.md"), calls)).toEqual(
      response("Read keep-awake.md"),
    );
    expect(() => validateSummaryIds(response("Done"), calls)).toThrow("2–8 words");
    expect(() =>
      validateSummaryIds(response("One two three four five six seven eight nine"), calls),
    ).toThrow("2–8 words");
  });

  it("includes status and evidence while bounding large output", () => {
    const call = summaryCall("one", {
      item: { ...shell, detail: { ...shell.detail, output: "start" + "x".repeat(70000) + "end" } },
      timestamp: "now",
    });
    expect(call.status).toBe("failed");
    expect(call.error).toBe('"exit 1"');
    expect(call.output.length).toBe(4000);
    expect(call.output).toContain("start");
    expect(call.output).toContain("end");
    expect(call.output).toContain("[truncated]");
  });
  it("accepts terminal shell/generic calls and excludes running/structured calls", () => {
    expect(isSummarizableToolCall(shell)).toBe(true);
    expect(isSummarizableToolCall({ ...shell, status: "running", error: null })).toBe(false);
    expect(isSummarizableToolCall({ ...shell, detail: { type: "read", filePath: "a.ts" } })).toBe(
      false,
    );
    expect(
      isSummarizableToolCall({ ...shell, detail: { type: "unknown", input: {}, output: {} } }),
    ).toBe(true);
  });
  it("rejects unknown, duplicate, missing, and oversized responses", () => {
    const calls = [summaryCall("one", { item: shell, timestamp: "now" })];
    expect(() => validateSummaryIds({ descriptions: [] }, calls)).toThrow("IDs");
    expect(() =>
      validateSummaryIds({ descriptions: [{ id: "other", description: "Text." }] }, calls),
    ).toThrow("IDs");
    expect(() =>
      validateSummaryIds(
        {
          descriptions: [
            { id: "one", description: "Text." },
            { id: "one", description: "Text." },
          ],
        },
        calls,
      ),
    ).toThrow("IDs");
    expect(
      SummaryResponseSchema.safeParse({
        descriptions: [{ id: "one", description: "x".repeat(601) }],
      }).success,
    ).toBe(false);
  });
});
