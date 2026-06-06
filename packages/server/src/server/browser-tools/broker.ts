import { randomUUID } from "node:crypto";
import {
  BrowserAutomationExecuteRequestSchema,
  BrowserAutomationExecuteResponseSchema,
  type BrowserAutomationCommand,
  type BrowserAutomationExecuteRequest,
  type BrowserAutomationExecuteResponse,
} from "@getpaseo/protocol/browser-automation/rpc-schemas";
import { browserToolsFailure, type BrowserToolsResponsePayload } from "./errors.js";
import type { BrowserToolsPolicy } from "./policy.js";

export interface BrowserToolsDesktopClient {
  id: string;
  sendBrowserAutomationRequest(request: BrowserAutomationExecuteRequest): void | Promise<void>;
}

export interface BrowserToolsExecuteInput {
  command: BrowserAutomationCommand;
  agentId?: string;
  cwd?: string;
  workspaceId?: string;
  browserId?: string;
  requestId?: string;
  timeoutMs?: number;
}

interface PendingBrowserToolsRequest {
  clientId: string;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (payload: BrowserToolsResponsePayload) => void;
}

export interface BrowserToolsBrokerOptions {
  policy: BrowserToolsPolicy;
  defaultTimeoutMs?: number;
  createRequestId?: () => string;
}

const DEFAULT_BROWSER_TOOLS_TIMEOUT_MS = 15_000;

export class BrowserToolsBroker {
  private readonly policy: BrowserToolsPolicy;
  private readonly defaultTimeoutMs: number;
  private readonly createRequestId: () => string;
  private readonly clients = new Map<string, BrowserToolsDesktopClient>();
  private readonly pending = new Map<string, PendingBrowserToolsRequest>();

  public constructor(options: BrowserToolsBrokerOptions) {
    this.policy = options.policy;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_BROWSER_TOOLS_TIMEOUT_MS;
    this.createRequestId = options.createRequestId ?? (() => `browser_${randomUUID()}`);
  }

  public registerClient(client: BrowserToolsDesktopClient): () => void {
    this.clients.set(client.id, client);
    return () => this.unregisterClient(client.id);
  }

  public unregisterClient(clientId: string): void {
    const deleted = this.clients.delete(clientId);
    if (!deleted) {
      return;
    }

    for (const [requestId, pending] of this.pending) {
      if (pending.clientId !== clientId) {
        continue;
      }
      this.pending.delete(requestId);
      clearTimeout(pending.timeout);
      pending.resolve(
        browserToolsFailure({
          requestId,
          code: "browser_no_desktop",
          message: "The desktop browser automation client disconnected before responding.",
          retryable: true,
        }),
      );
    }
  }

  public getPendingRequestCount(): number {
    return this.pending.size;
  }

  public getRegisteredClientCount(): number {
    return this.clients.size;
  }

  public async execute(input: BrowserToolsExecuteInput): Promise<BrowserToolsResponsePayload> {
    const requestId = input.requestId ?? this.createRequestId();

    if (!this.policy.isEnabled()) {
      return browserToolsFailure({
        requestId,
        code: "browser_disabled",
        message: "Browser tools are disabled. Enable daemon.browserTools.enabled to use them.",
      });
    }

    const client = this.selectClient();
    if (!client) {
      return browserToolsFailure({
        requestId,
        code: "browser_no_desktop",
        message: "No desktop browser automation client is connected.",
        retryable: true,
      });
    }

    const request = BrowserAutomationExecuteRequestSchema.safeParse({
      type: "browser.automation.execute.request",
      requestId,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.browserId ? { browserId: input.browserId } : {}),
      command: input.command,
    });

    if (!request.success) {
      return browserToolsFailure({
        requestId,
        code: "browser_unknown_error",
        message: formatBrowserAutomationValidationError(request.error.issues[0]?.message),
      });
    }

    return this.sendRequest({
      client,
      request: request.data,
      timeoutMs: input.timeoutMs ?? this.defaultTimeoutMs,
    });
  }

  public receiveResponse(response: BrowserAutomationExecuteResponse): boolean {
    const parsed = BrowserAutomationExecuteResponseSchema.safeParse(response);
    if (!parsed.success) {
      const requestId = getBrowserAutomationResponseRequestId(response);
      if (!requestId) {
        return false;
      }

      const pending = this.pending.get(requestId);
      if (!pending) {
        return false;
      }

      this.pending.delete(requestId);
      clearTimeout(pending.timeout);
      pending.resolve(
        browserToolsFailure({
          requestId,
          code: "browser_unknown_error",
          message: formatBrowserAutomationResponseValidationError(parsed.error.issues[0]?.message),
        }),
      );
      return true;
    }

    const pending = this.pending.get(parsed.data.payload.requestId);
    if (!pending) {
      return false;
    }

    this.pending.delete(parsed.data.payload.requestId);
    clearTimeout(pending.timeout);
    pending.resolve(parsed.data.payload);
    return true;
  }

  private selectClient(): BrowserToolsDesktopClient | null {
    for (const client of this.clients.values()) {
      return client;
    }
    return null;
  }

  private sendRequest(params: {
    client: BrowserToolsDesktopClient;
    request: BrowserAutomationExecuteRequest;
    timeoutMs: number;
  }): Promise<BrowserToolsResponsePayload> {
    const { client, request, timeoutMs } = params;

    return new Promise<BrowserToolsResponsePayload>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!this.pending.delete(request.requestId)) {
          return;
        }
        resolve(
          browserToolsFailure({
            requestId: request.requestId,
            code: "browser_timeout",
            message: `Browser automation timed out after ${timeoutMs}ms.`,
            retryable: true,
          }),
        );
      }, timeoutMs);

      this.pending.set(request.requestId, {
        clientId: client.id,
        timeout,
        resolve,
      });

      Promise.resolve(client.sendBrowserAutomationRequest(request)).catch((error: unknown) => {
        if (!this.pending.delete(request.requestId)) {
          return;
        }
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }
}

function formatBrowserAutomationValidationError(message: string | undefined): string {
  if (!message) {
    return "Browser automation request is invalid.";
  }
  return `Browser automation request is invalid: ${message}.`;
}

function formatBrowserAutomationResponseValidationError(message: string | undefined): string {
  if (!message) {
    return "Browser automation response is invalid.";
  }
  return `Browser automation response is invalid: ${message}.`;
}

function getBrowserAutomationResponseRequestId(response: unknown): string | null {
  if (!isRecord(response)) {
    return null;
  }
  const payload = response.payload;
  if (!isRecord(payload) || typeof payload.requestId !== "string") {
    return null;
  }
  return payload.requestId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
