import assert from "node:assert/strict";
import { describe, it } from "vitest";

import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import { hasMeaningfulToolCallDetail, isPendingToolCallDetail } from "./tool-call-detail-state";

describe("tool-call detail state", () => {
  it("treats empty unknown payloads as not meaningful", () => {
    const detail: ToolCallDetail = {
      type: "unknown",
      input: {},
      output: null,
    };

    assert.strictEqual(hasMeaningfulToolCallDetail(detail), false);
  });

  it("treats partial unknown payloads with real values as meaningful", () => {
    const detail: ToolCallDetail = {
      type: "unknown",
      input: { path: "src/index.ts" },
      output: null,
    };

    assert.strictEqual(hasMeaningfulToolCallDetail(detail), true);
  });

  it("marks running calls with no meaningful detail as pending", () => {
    assert.strictEqual(
      isPendingToolCallDetail({
        detail: {
          type: "unknown",
          input: {},
          output: null,
        },
        status: "running",
        error: null,
      }),
      true,
    );
  });

  it("does not mark completed calls as pending", () => {
    assert.strictEqual(
      isPendingToolCallDetail({
        detail: {
          type: "unknown",
          input: {},
          output: null,
        },
        status: "completed",
        error: null,
      }),
      false,
    );
  });

  it("treats enriched search detail as meaningful", () => {
    const detail: ToolCallDetail = {
      type: "search",
      query: "needle",
      toolName: "grep",
      content: "12:needle",
      filePaths: ["src/index.ts"],
    };

    assert.strictEqual(hasMeaningfulToolCallDetail(detail), true);
  });

  it("treats fetch detail as meaningful", () => {
    const detail: ToolCallDetail = {
      type: "fetch",
      url: "https://example.com",
      result: "Fetched summary",
    };

    assert.strictEqual(hasMeaningfulToolCallDetail(detail), true);
  });
});
