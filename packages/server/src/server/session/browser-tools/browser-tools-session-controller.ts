import { getErrorMessage } from "@getpaseo/protocol/error-utils";
import type pino from "pino";
import type { BrowserToolResult } from "../../messages.js";
import type { SessionInboundMessage, SessionOutboundMessage } from "../../messages.js";
import type { BrowserToolsBroker } from "../../browser-tools/broker.js";
import { createBrowserToolsCatalog } from "../../browser-tools/catalog.js";
import type { BrowserToolsPolicy } from "../../browser-tools/policy.js";

type BrowserToolExecuteRequest = Extract<
  SessionInboundMessage,
  { type: "browser.tool.execute.request" }
>;

const BROWSER_TOOLS_MESSAGE_TYPES: ReadonlySet<SessionInboundMessage["type"]> = new Set([
  "browser.tool.execute.request",
]);

export interface BrowserToolsSessionControllerOptions {
  broker: Pick<BrowserToolsBroker, "execute"> | null | undefined;
  policy: BrowserToolsPolicy;
  emit: (msg: SessionOutboundMessage) => void;
  sessionLogger: pino.Logger;
}

function isBrowserToolsMessage(msg: SessionInboundMessage): msg is BrowserToolExecuteRequest {
  return BROWSER_TOOLS_MESSAGE_TYPES.has(msg.type);
}

export class BrowserToolsSessionController {
  private readonly broker: Pick<BrowserToolsBroker, "execute"> | null;
  private readonly policy: BrowserToolsPolicy;
  private readonly emit: (msg: SessionOutboundMessage) => void;
  private readonly sessionLogger: pino.Logger;

  constructor(options: BrowserToolsSessionControllerOptions) {
    this.broker = options.broker ?? null;
    this.policy = options.policy;
    this.emit = options.emit;
    this.sessionLogger = options.sessionLogger;
  }

  dispatch(msg: SessionInboundMessage): Promise<void> | undefined {
    if (!isBrowserToolsMessage(msg)) {
      return undefined;
    }
    return this.handleExecuteRequest(msg);
  }

  private async handleExecuteRequest(msg: BrowserToolExecuteRequest): Promise<void> {
    const broker = this.broker;
    if (!broker || !this.policy.isEnabled()) {
      this.emitError(
        msg,
        "browser_disabled",
        "Browser tools are disabled on this daemon. Enable browserTools in the daemon config to use browser commands.",
      );
      return;
    }

    try {
      const catalog = createBrowserToolsCatalog({
        broker,
        resolveCallerAgent: () =>
          msg.cwd || msg.workspaceId
            ? {
                id: msg.requestId,
                cwd: msg.cwd ?? "",
                ...(msg.workspaceId ? { workspaceId: msg.workspaceId } : {}),
              }
            : null,
      });
      const result = await catalog.executeTool(msg.tool, msg.input ?? {});
      this.emit({
        type: "browser.tool.execute.response",
        payload: { requestId: msg.requestId, result: result as BrowserToolResult },
      });
    } catch (error) {
      this.sessionLogger.warn(
        { tool: msg.tool, error: getErrorMessage(error) },
        "browser tool execution failed",
      );
      this.emitError(msg, "browser_tool_failed", getErrorMessage(error));
    }
  }

  private emitError(msg: BrowserToolExecuteRequest, code: string, error: string): void {
    this.emit({
      type: "rpc_error",
      payload: {
        requestId: msg.requestId,
        requestType: "browser.tool.execute.request",
        error,
        code,
      },
    });
  }
}
