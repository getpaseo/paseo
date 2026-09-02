import { describe, expect, it } from "vitest";
import {
  MAX_PLUGIN_PROCESS_MESSAGE_BYTES,
  validatePluginProcessMessage,
  validatePluginProcessRequest,
} from "./plugin-process-protocol.js";
import { PLUGIN_TOOL_MAX_ERROR_BYTES } from "./plugin-tool.js";

const callerContext = {
  callerAgentId: "agent-1",
  agent: { id: "agent-1", status: "running" },
  workspace: null,
};

describe("plugin process tool protocol", () => {
  it("validates separate invoke, update, result, and cancel envelopes", () => {
    expect(
      validatePluginProcessRequest({
        type: "tool_invoke",
        requestId: "request-1",
        name: "acme.lookup",
        input: { query: "paseo" },
        context: callerContext,
      }),
    ).toMatchObject({ type: "tool_invoke", context: callerContext });
    expect(
      validatePluginProcessMessage({
        type: "tool_update",
        requestId: "request-1",
        update: { progress: 0.5 },
      }),
    ).toEqual({ type: "tool_update", requestId: "request-1", update: { progress: 0.5 } });
    expect(
      validatePluginProcessMessage({
        type: "tool_result",
        requestId: "request-1",
        output: { ok: true },
      }),
    ).toEqual({ type: "tool_result", requestId: "request-1", output: { ok: true } });
    expect(validatePluginProcessRequest({ type: "tool_cancel", requestId: "request-1" })).toEqual({
      type: "tool_cancel",
      requestId: "request-1",
    });
    expect(
      validatePluginProcessMessage({ type: "tool_cancel_ack", requestId: "request-1" }),
    ).toEqual({ type: "tool_cancel_ack", requestId: "request-1" });
  });

  it("rejects unknown fields and oversized messages", () => {
    expect(() =>
      validatePluginProcessRequest({
        type: "tool_cancel",
        requestId: "request-1",
        callerAgentId: "spoofed",
      }),
    ).toThrow();
    expect(() =>
      validatePluginProcessMessage({
        type: "tool_result",
        requestId: "request-1",
        output: { value: "x".repeat(MAX_PLUGIN_PROCESS_MESSAGE_BYTES) },
      }),
    ).toThrow(/size|byte|limit/i);
    expect(() =>
      validatePluginProcessMessage({
        type: "tool_error",
        requestId: "request-1",
        error: "€".repeat(PLUGIN_TOOL_MAX_ERROR_BYTES),
      }),
    ).toThrow(/byte|limit/i);
  });
});
