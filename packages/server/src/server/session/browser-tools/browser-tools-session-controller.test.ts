import pino from "pino";
import { describe, expect, test } from "vitest";
import type { BrowserToolsExecuteInput } from "../../browser-tools/broker.js";
import type { BrowserToolsResponsePayload } from "../../browser-tools/errors.js";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import { BrowserToolsSessionController } from "./browser-tools-session-controller.js";

const BROWSER_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_CONTEXT_MESSAGE =
  "This browser tool needs a workspace. Start the agent from a Paseo workspace before calling browser_new_tab or browser_list_tabs.";

class FakeBroker {
  public readonly calls: BrowserToolsExecuteInput[] = [];

  public constructor(private readonly response: BrowserToolsResponsePayload) {}

  public async execute(input: BrowserToolsExecuteInput): Promise<BrowserToolsResponsePayload> {
    this.calls.push(input);
    return this.response;
  }
}

function clickSuccess(): BrowserToolsResponsePayload {
  return {
    ok: true,
    requestId: "req-1",
    result: { command: "click", browserId: BROWSER_ID, ref: "@e1" },
  };
}

function harness(options?: { enabled?: boolean; response?: BrowserToolsResponsePayload }) {
  const broker = new FakeBroker(options?.response ?? clickSuccess());
  const emitted: SessionOutboundMessage[] = [];
  const controller = new BrowserToolsSessionController({
    broker,
    policy: { isEnabled: () => options?.enabled !== false },
    emit: (message) => emitted.push(message),
    sessionLogger: pino({ level: "silent" }),
  });
  return { broker, emitted, controller };
}

function executeRequest(
  overrides: Partial<Extract<SessionInboundMessage, { type: "browser.tool.execute.request" }>> = {},
): SessionInboundMessage {
  return {
    type: "browser.tool.execute.request",
    tool: "browser_click",
    input: { browserId: BROWSER_ID, ref: "@e1" },
    cwd: "/repo",
    workspaceId: "wks_workspace_a",
    requestId: "req-1",
    ...overrides,
  } as SessionInboundMessage;
}

describe("BrowserToolsSessionController", () => {
  test("ignores messages it does not own", () => {
    const { controller } = harness();
    expect(controller.dispatch({ type: "ping" } as SessionInboundMessage)).toBeUndefined();
  });

  test("forwards the browser command the matching agent tool would send", async () => {
    const { broker, emitted, controller } = harness();

    await controller.dispatch(executeRequest());

    expect(broker.calls).toEqual([
      {
        cwd: "/repo",
        workspaceId: "wks_workspace_a",
        command: {
          command: "click",
          args: {
            browserId: BROWSER_ID,
            ref: "@e1",
            button: "left",
            doubleClick: false,
            modifiers: [],
          },
        },
      },
    ]);
    expect(emitted).toEqual([
      {
        type: "browser.tool.execute.response",
        payload: {
          requestId: "req-1",
          result: expect.objectContaining({
            content: [{ type: "text", text: "Clicked browser element @e1." }],
            structuredContent: expect.objectContaining({ ok: true }),
          }),
        },
      },
    ]);
  });

  test("rejects input the browser tool schema does not accept", async () => {
    const { broker, emitted, controller } = harness();

    await controller.dispatch(executeRequest({ input: { browserId: "nope", ref: "@e1" } }));

    expect(broker.calls).toEqual([]);
    expect(emitted[0]).toMatchObject({
      type: "rpc_error",
      payload: {
        requestId: "req-1",
        requestType: "browser.tool.execute.request",
        code: "browser_tool_failed",
      },
    });
  });

  test("keeps the workspace guard agents get when the caller has no workspace", async () => {
    const { broker, emitted, controller } = harness();

    await controller.dispatch(
      executeRequest({
        tool: "browser_new_tab",
        input: { url: "https://example.com" },
        cwd: undefined,
        workspaceId: undefined,
      }),
    );

    expect(broker.calls).toEqual([]);
    expect(emitted[0]).toMatchObject({
      type: "browser.tool.execute.response",
      payload: {
        result: {
          content: [{ type: "text", text: WORKSPACE_CONTEXT_MESSAGE }],
          structuredContent: { ok: false, error: { code: "browser_denied" } },
        },
      },
    });
  });

  test("refuses to touch the broker while browser tools are disabled", async () => {
    const { broker, emitted, controller } = harness({ enabled: false });

    await controller.dispatch(executeRequest());

    expect(broker.calls).toEqual([]);
    expect(emitted[0]).toMatchObject({
      type: "rpc_error",
      payload: { requestId: "req-1", code: "browser_disabled" },
    });
  });

  test("reports browser failures as a tool result instead of an rpc error", async () => {
    const { emitted, controller } = harness({
      response: {
        ok: false,
        requestId: "req-1",
        error: { code: "browser_no_host", message: "no host", retryable: true },
      },
    });

    await controller.dispatch(executeRequest());

    expect(emitted[0]).toMatchObject({
      type: "browser.tool.execute.response",
      payload: { result: { structuredContent: { ok: false, error: { code: "browser_no_host" } } } },
    });
  });
});
