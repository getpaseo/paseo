import { createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  BrowserAutomationExecuteRequestSchema,
  BrowserAutomationExecuteResponseSchema,
  type BrowserAutomationCommand,
  type BrowserAutomationCommandName,
  type BrowserAutomationExecuteRequest,
  type BrowserAutomationExecuteResponse,
} from "@getpaseo/protocol/browser-automation/rpc-schemas";
import {
  browserToolsFailure,
  type BrowserHostTarget,
  type BrowserToolsResponsePayload,
} from "./errors.js";

export interface BrowserHostClient {
  id: string;
  hostKind: string;
  label?: string;
  instanceId?: string;
  supportedCommands: readonly BrowserAutomationCommandName[];
  sendBrowserAutomationRequest(request: BrowserAutomationExecuteRequest): void | Promise<void>;
}

export interface BrowserToolsExecuteInput {
  command: BrowserAutomationCommand;
  agentId?: string;
  cwd?: string;
  workspaceId?: string;
  requestId?: string;
  timeoutMs?: number;
  browserHostId?: string;
}

interface PendingBrowserToolsRequest {
  host: RegisteredBrowserHost;
  rememberAffinity: boolean;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (payload: BrowserToolsResponsePayload) => void;
}

interface RegisteredBrowserHost {
  client: BrowserHostClient;
  target: BrowserHostTarget;
  registeredAt: number;
  supportedCommands: ReadonlySet<BrowserAutomationCommandName>;
}

type HostSelection =
  | { ok: true; value: RegisteredBrowserHost }
  | { ok: false; payload: BrowserToolsResponsePayload };

export interface BrowserToolsBrokerOptions {
  defaultTimeoutMs?: number;
  createRequestId?: () => string;
}

const DEFAULT_BROWSER_TOOLS_TIMEOUT_MS = 15_000;

export class BrowserToolsBroker {
  private readonly defaultTimeoutMs: number;
  private readonly createRequestId: () => string;
  private readonly clients = new Map<string, RegisteredBrowserHost>();
  private readonly pending = new Map<string, PendingBrowserToolsRequest>();
  private readonly browserHostByBrowserId = new Map<string, string>();
  private readonly hostIdKey = randomBytes(32);
  private registrationSequence = 0;

  public constructor(options: BrowserToolsBrokerOptions) {
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_BROWSER_TOOLS_TIMEOUT_MS;
    this.createRequestId = options.createRequestId ?? (() => `browser_${randomUUID()}`);
  }

  public registerClient(client: BrowserHostClient): () => void {
    // The discovery ID must not allow another connection to claim this window.
    const browserHostId = createHmac("sha256", this.hostIdKey)
      .update(client.instanceId ? `instance:${client.instanceId}` : `connection:${client.id}`)
      .digest("hex");
    this.unregisterHost(browserHostId);
    const registeredAt = ++this.registrationSequence;
    const label = client.label?.trim() || `${client.hostKind} · Connection ${registeredAt}`;
    const supportedCommands = new Set(client.supportedCommands);
    this.clients.set(browserHostId, {
      client,
      target: Object.freeze({
        browserHostId,
        label,
        canOpenTabs: supportedCommands.has("new_tab"),
      }),
      registeredAt,
      supportedCommands,
    });
    return () => this.unregisterHost(browserHostId, registeredAt);
  }

  private unregisterHost(browserHostId: string, registeredAt?: number): void {
    const current = this.clients.get(browserHostId);
    if (!current || (registeredAt !== undefined && current.registeredAt !== registeredAt)) {
      return;
    }
    this.clients.delete(browserHostId);

    for (const [requestId, pending] of this.pending) {
      if (pending.host !== current) continue;
      this.pending.delete(requestId);
      clearTimeout(pending.timeout);
      pending.resolve(
        browserToolsFailure({
          requestId,
          code: "browser_no_host",
          message: "The browser automation host disconnected before responding.",
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

  public listBrowserHosts(): BrowserHostTarget[] {
    return Array.from(this.clients.values(), ({ target }) => target);
  }

  public async execute(input: BrowserToolsExecuteInput): Promise<BrowserToolsResponsePayload> {
    const requestId = input.requestId ?? this.createRequestId();

    const request = BrowserAutomationExecuteRequestSchema.safeParse({
      type: "browser.automation.execute.request",
      requestId,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      command: input.command,
    });

    if (!request.success) {
      return browserToolsFailure({
        requestId,
        code: "browser_unknown_error",
        message: formatBrowserAutomationValidationError(request.error.issues[0]?.message),
      });
    }

    if (request.data.command.command === "list_tabs") {
      return this.executeListTabs({
        request: request.data,
        timeoutMs: input.timeoutMs ?? this.defaultTimeoutMs,
      });
    }

    const command = request.data.command;
    const host =
      command.command === "new_tab"
        ? this.selectHostForNewTab(requestId, input.browserHostId)
        : this.selectHostForTab(command.args.browserId, requestId);
    if (!host.ok) {
      return host.payload;
    }

    const unsupported = this.unsupportedCommandFailure({
      host: host.value,
      commandName: request.data.command.command,
      requestId,
    });
    if (unsupported) {
      return unsupported;
    }

    return this.sendRequest({
      host: host.value,
      request: request.data,
      timeoutMs: input.timeoutMs ?? this.defaultTimeoutMs,
    });
  }

  public receiveResponse(
    response: BrowserAutomationExecuteResponse,
    clientIds?: readonly string[],
  ): boolean {
    const parsed = BrowserAutomationExecuteResponseSchema.safeParse(response);
    if (!parsed.success) {
      const requestId = getBrowserAutomationResponseRequestId(response);
      if (!requestId) {
        return false;
      }

      const pending = this.pending.get(requestId);
      if (!pending || (clientIds && !clientIds.includes(pending.host.client.id))) {
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
    if (!pending || (clientIds && !clientIds.includes(pending.host.client.id))) {
      return false;
    }

    this.pending.delete(parsed.data.payload.requestId);
    clearTimeout(pending.timeout);
    if (pending.rememberAffinity && parsed.data.payload.ok) {
      this.rememberBrowserHostForPayload(pending.host.target.browserHostId, parsed.data.payload);
    }
    pending.resolve(attachBrowserHost(parsed.data.payload, pending.host.target));
    return true;
  }

  private async executeListTabs(params: {
    request: BrowserAutomationExecuteRequest;
    timeoutMs: number;
  }): Promise<BrowserToolsResponsePayload> {
    const hosts = Array.from(this.clients.values());
    if (hosts.length === 0) {
      return this.noBrowserHostFailure(params.request.requestId);
    }

    for (const host of hosts) {
      const unsupported = this.unsupportedCommandFailure({
        host,
        commandName: "list_tabs",
        requestId: params.request.requestId,
      });
      if (unsupported) {
        return unsupported;
      }
    }

    if (hosts.length === 1) {
      return this.sendRequest({
        host: hosts[0],
        request: params.request,
        timeoutMs: params.timeoutMs,
      });
    }

    const hostResponses = await Promise.all(
      hosts.map(async (host) => ({
        host,
        payload: await this.sendRequest({
          host,
          request: {
            ...params.request,
            requestId: `${params.request.requestId}:${host.client.id}`,
          },
          rememberAffinity: false,
          timeoutMs: params.timeoutMs,
        }),
      })),
    );

    const failed = hostResponses.find(({ payload }) => !payload.ok);
    if (failed) {
      return withBrowserToolsRequestId(failed.payload, params.request.requestId);
    }

    for (const { host, payload } of hostResponses) {
      if (payload.ok && this.clients.get(host.target.browserHostId) === host) {
        this.rememberBrowserHostForPayload(host.target.browserHostId, payload);
      }
    }

    return {
      requestId: params.request.requestId,
      ok: true,
      result: {
        command: "list_tabs",
        tabs: hostResponses.flatMap(({ payload }) =>
          payload.ok && payload.result.command === "list_tabs" ? payload.result.tabs : [],
        ),
      },
    };
  }

  private selectHostForNewTab(requestId: string, browserHostId: string | undefined): HostSelection {
    if (browserHostId !== undefined) {
      const host = this.clients.get(browserHostId);
      if (host) return { ok: true, value: host };
      return {
        ok: false,
        payload: browserToolsFailure({
          requestId,
          code: "browser_no_host",
          message:
            "The selected browser host is not connected. Call browser_list_hosts to choose a connected host.",
        }),
      };
    }

    if (this.clients.size === 0)
      return { ok: false, payload: this.noBrowserHostFailure(requestId) };
    const eligible = Array.from(this.clients.values()).filter(({ target }) => target.canOpenTabs);
    if (eligible.length === 1) return { ok: true, value: eligible[0] };
    if (eligible.length === 0) {
      return {
        ok: false,
        payload: browserToolsFailure({
          requestId,
          code: "browser_unsupported",
          message: "None of the connected browser hosts support opening tabs.",
        }),
      };
    }
    return {
      ok: false,
      payload: browserToolsFailure({
        requestId,
        code: "browser_host_ambiguous",
        message: "Choose a browser host and retry with its browserHostId.",
        browserHosts: eligible.map(({ target }) => target),
      }),
    };
  }

  private selectHostForTab(browserId: string, requestId: string): HostSelection {
    const browserHostId = this.browserHostByBrowserId.get(browserId);
    if (browserHostId) {
      const host = this.clients.get(browserHostId);
      return host
        ? { ok: true, value: host }
        : { ok: false, payload: this.strandedBrowserTabFailure({ requestId, browserId }) };
    }

    const firstHost = this.clients.values().next().value;
    if (!firstHost) {
      return { ok: false, payload: this.noBrowserHostFailure(requestId) };
    }
    if (this.clients.size === 1) return { ok: true, value: firstHost };

    return {
      ok: false,
      payload: browserToolsFailure({
        requestId,
        code: "browser_tab_not_found",
        message: `Browser tab ${browserId} is not associated with a connected browser automation host. Call browser_list_tabs and use one of the returned browserId values.`,
      }),
    };
  }

  private unsupportedCommandFailure(params: {
    host: RegisteredBrowserHost;
    commandName: BrowserAutomationCommandName;
    requestId: string;
  }): BrowserToolsResponsePayload | null {
    if (params.host.supportedCommands.has(params.commandName)) {
      return null;
    }
    return browserToolsFailure({
      requestId: params.requestId,
      code: "browser_unsupported",
      message: `Browser automation command "${params.commandName}" is not supported by the ${describeBrowserHost(params.host)}.`,
    });
  }

  private noBrowserHostFailure(requestId: string): BrowserToolsResponsePayload {
    return browserToolsFailure({
      requestId,
      code: "browser_no_host",
      message: "No browser automation host is connected.",
      retryable: true,
    });
  }

  private strandedBrowserTabFailure(params: {
    requestId: string;
    browserId: string;
  }): BrowserToolsResponsePayload {
    return browserToolsFailure({
      requestId: params.requestId,
      code: "browser_no_host",
      message: `The app hosting browser tab ${params.browserId} disconnected.`,
      retryable: true,
    });
  }

  private rememberBrowserHostForPayload(
    browserHostId: string,
    payload: Extract<BrowserAutomationExecuteResponse["payload"], { ok: true }>,
  ): void {
    if (payload.result.command === "list_tabs") {
      for (const tab of payload.result.tabs) {
        this.browserHostByBrowserId.set(tab.browserId, browserHostId);
      }
      return;
    }

    if (payload.result.command === "close_tab") {
      this.browserHostByBrowserId.delete(payload.result.browserId);
      return;
    }

    if ("browserId" in payload.result) {
      this.browserHostByBrowserId.set(payload.result.browserId, browserHostId);
    }
  }

  private sendRequest(params: {
    host: RegisteredBrowserHost;
    request: BrowserAutomationExecuteRequest;
    rememberAffinity?: boolean;
    timeoutMs: number;
  }): Promise<BrowserToolsResponsePayload> {
    const { host, request, timeoutMs } = params;
    const client = host.client;

    return new Promise<BrowserToolsResponsePayload>((resolve) => {
      const timeout = setTimeout(() => {
        if (!this.pending.delete(request.requestId)) {
          return;
        }
        resolve(
          browserToolsFailure({
            requestId: request.requestId,
            code: "browser_timeout",
            message: `The browser host did not respond within ${timeoutMs}ms. Try again or check the browser host.`,
            retryable: true,
          }),
        );
      }, timeoutMs);

      this.pending.set(request.requestId, {
        host,
        rememberAffinity: params.rememberAffinity ?? true,
        timeout,
        resolve,
      });

      try {
        Promise.resolve(client.sendBrowserAutomationRequest(request)).catch((error: unknown) => {
          resolveSendFailure({
            requestId: request.requestId,
            pending: this.pending,
            timeout,
            resolve,
            error,
          });
        });
      } catch (error) {
        resolveSendFailure({
          requestId: request.requestId,
          pending: this.pending,
          timeout,
          resolve,
          error,
        });
      }
    });
  }
}

function attachBrowserHost(
  payload: BrowserAutomationExecuteResponse["payload"],
  target: BrowserHostTarget,
): BrowserToolsResponsePayload {
  if (!payload.ok) return payload;
  const result = payload.result;
  if (result.command === "new_tab") {
    return { ...payload, result: { ...result, browserHost: target } };
  }
  if (result.command === "list_tabs") {
    const tabs = result.tabs.map((tab) => ({ ...tab, browserHost: target }));
    return { ...payload, result: { ...result, tabs } };
  }
  return { ...payload, result };
}

function describeBrowserHost(host: RegisteredBrowserHost): string {
  const hostKind = host.client.hostKind.trim();
  return hostKind || "browser host";
}

function withBrowserToolsRequestId(
  payload: BrowserToolsResponsePayload,
  requestId: string,
): BrowserToolsResponsePayload {
  return { ...payload, requestId } as BrowserToolsResponsePayload;
}

function resolveSendFailure(params: {
  requestId: string;
  pending: Map<string, PendingBrowserToolsRequest>;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (payload: BrowserToolsResponsePayload) => void;
  error: unknown;
}): void {
  if (!params.pending.delete(params.requestId)) {
    return;
  }
  clearTimeout(params.timeout);
  params.resolve(
    browserToolsFailure({
      requestId: params.requestId,
      code: "browser_unknown_error",
      message: formatBrowserAutomationSendError(params.error),
    }),
  );
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

function formatBrowserAutomationSendError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return `Browser automation request failed to send: ${error.message}`;
  }
  return `Browser automation request failed to send: ${String(error)}`;
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
