import { describe, expect, test, vi } from "vitest";
import type { SessionInboundMessage, SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { mountBrowserAutomationHandler } from "./handler";
import type { DesktopHostBridge } from "@/desktop/host";

type BrowserAutomationExecuteRequest = Extract<
  SessionOutboundMessage,
  { type: "browser.automation.execute.request" }
>;
type BrowserAutomationExecuteResponse = Extract<
  SessionInboundMessage,
  { type: "browser.automation.execute.response" }
>;

class FakeDaemonClient {
  public sentResponses: BrowserAutomationExecuteResponse[] = [];
  private handler: ((request: BrowserAutomationExecuteRequest) => void) | null = null;

  public on(
    type: "browser.automation.execute.request",
    handler: (request: BrowserAutomationExecuteRequest) => void,
  ): () => void {
    expect(type).toBe("browser.automation.execute.request");
    this.handler = handler;
    return () => {
      if (this.handler === handler) {
        this.handler = null;
      }
    };
  }

  public sendBrowserAutomationExecuteResponse(response: BrowserAutomationExecuteResponse): void {
    this.sentResponses.push(response);
  }

  public receive(nextRequest: BrowserAutomationExecuteRequest): void {
    this.handler?.(nextRequest);
  }
}

function browserAutomationRequest(): BrowserAutomationExecuteRequest {
  return {
    type: "browser.automation.execute.request",
    requestId: "req-1",
    command: { command: "list_tabs", args: {} },
  };
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("mountBrowserAutomationHandler", () => {
  test("sends a success response from the desktop bridge", async () => {
    const client = new FakeDaemonClient();
    const executeAutomationCommand = vi.fn(async () => ({
      requestId: "req-1",
      ok: true as const,
      result: { command: "list_tabs" as const, tabs: [] },
    }));

    mountBrowserAutomationHandler({
      client,
      getHost: () => ({ browser: { executeAutomationCommand } }) satisfies DesktopHostBridge,
    });

    client.receive(browserAutomationRequest());
    await flushPromises();

    expect(executeAutomationCommand).toHaveBeenCalledWith(browserAutomationRequest());
    expect(client.sentResponses).toEqual([
      {
        type: "browser.automation.execute.response",
        payload: {
          requestId: "req-1",
          ok: true,
          result: { command: "list_tabs", tabs: [] },
        },
      },
    ]);
  });

  test("missing bridge sends browser_unsupported", async () => {
    const client = new FakeDaemonClient();
    mountBrowserAutomationHandler({ client, getHost: () => null });

    client.receive(browserAutomationRequest());
    await flushPromises();

    expect(client.sentResponses).toEqual([
      {
        type: "browser.automation.execute.response",
        payload: {
          requestId: "req-1",
          ok: false,
          error: {
            code: "browser_unsupported",
            message: "Desktop browser automation is not available in this app runtime.",
            retryable: false,
          },
        },
      },
    ]);
  });

  test("typed bridge errors become failure responses", async () => {
    const client = new FakeDaemonClient();
    mountBrowserAutomationHandler({
      client,
      getHost: () => ({
        browser: {
          executeAutomationCommand: async () => {
            throw {
              code: "browser_tab_not_found",
              message: "Browser tab browser-1 was not found.",
              retryable: false,
            };
          },
        },
      }),
    });

    client.receive(browserAutomationRequest());
    await flushPromises();

    expect(client.sentResponses[0]?.payload).toEqual({
      requestId: "req-1",
      ok: false,
      error: {
        code: "browser_tab_not_found",
        message: "Browser tab browser-1 was not found.",
        retryable: false,
      },
    });
  });

  test("unimplemented preload IPC reports browser_unsupported", async () => {
    const client = new FakeDaemonClient();
    mountBrowserAutomationHandler({
      client,
      getHost: () => ({
        browser: {
          executeAutomationCommand: async () => {
            throw new Error('No handler registered for "paseo:browser:execute-automation-command"');
          },
        },
      }),
    });

    client.receive(browserAutomationRequest());
    await flushPromises();

    expect(client.sentResponses[0]?.payload).toEqual({
      requestId: "req-1",
      ok: false,
      error: {
        code: "browser_unsupported",
        message: "Desktop browser automation is not implemented by this desktop build yet.",
        retryable: false,
      },
    });
  });

  test("unsubscribe stops handling requests", async () => {
    const client = new FakeDaemonClient();
    const executeAutomationCommand = vi.fn(async () => ({
      requestId: "req-1",
      ok: true as const,
      result: { command: "list_tabs" as const, tabs: [] },
    }));
    const unsubscribe = mountBrowserAutomationHandler({
      client,
      getHost: () => ({ browser: { executeAutomationCommand } }),
    });

    unsubscribe();
    client.receive(browserAutomationRequest());
    await flushPromises();

    expect(executeAutomationCommand).not.toHaveBeenCalled();
    expect(client.sentResponses).toEqual([]);
  });
});
