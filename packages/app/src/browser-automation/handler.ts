import type { SessionInboundMessage, SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { getDesktopHost, type DesktopHostBridge } from "@/desktop/host";
import { createWorkspaceBrowser } from "@/stores/browser-store";
import {
  buildWorkspaceTabPersistenceKey,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import { navigateToWorkspace as navigateToWorkspaceRoute } from "@/stores/navigation-active-workspace-store";
import { isWeb } from "@/constants/platform";

type BrowserAutomationExecuteRequest = Extract<
  SessionOutboundMessage,
  { type: "browser.automation.execute.request" }
>;
type BrowserAutomationExecuteResponse = Extract<
  SessionInboundMessage,
  { type: "browser.automation.execute.response" }
>;
type BrowserAutomationResponsePayload = BrowserAutomationExecuteResponse["payload"];
type BrowserAutomationFailurePayload = Extract<BrowserAutomationResponsePayload, { ok: false }>;
type BrowserAutomationErrorCode = BrowserAutomationFailurePayload["error"]["code"];

interface BrowserAutomationClient {
  on(
    type: "browser.automation.execute.request",
    handler: (message: BrowserAutomationExecuteRequest) => void,
  ): () => void;
  sendBrowserAutomationExecuteResponse(response: BrowserAutomationExecuteResponse): void;
}

interface AutomationWebviewElement extends HTMLElement {
  src: string;
}

export interface BrowserAutomationHandlerOptions {
  client: BrowserAutomationClient;
  serverId?: string;
  getHost?: () => DesktopHostBridge | null;
  navigateToWorkspace?: (serverId: string, workspaceId: string) => void;
  registrationWaitTimeoutMs?: number;
  registrationPollIntervalMs?: number;
}

export function mountBrowserAutomationHandler(
  options: BrowserAutomationHandlerOptions,
): () => void {
  const getHost = options.getHost ?? getDesktopHost;
  return options.client.on("browser.automation.execute.request", (request) => {
    void handleBrowserAutomationRequest({
      client: options.client,
      getHost,
      request,
      serverId: options.serverId,
      navigateToWorkspace: options.navigateToWorkspace ?? navigateToWorkspaceRoute,
      ...(options.registrationWaitTimeoutMs !== undefined
        ? { registrationWaitTimeoutMs: options.registrationWaitTimeoutMs }
        : {}),
      ...(options.registrationPollIntervalMs !== undefined
        ? { registrationPollIntervalMs: options.registrationPollIntervalMs }
        : {}),
    });
  });
}

export function mountBrowserAutomationDaemonClientHandler(
  client: unknown,
  options?: { serverId?: string },
): () => void {
  return mountBrowserAutomationHandler({
    client: client as BrowserAutomationClient,
    ...(options?.serverId ? { serverId: options.serverId } : {}),
  });
}

async function handleBrowserAutomationRequest(params: {
  client: BrowserAutomationHandlerOptions["client"];
  getHost: () => DesktopHostBridge | null;
  request: BrowserAutomationExecuteRequest;
  serverId?: string;
  navigateToWorkspace: (serverId: string, workspaceId: string) => void;
  registrationWaitTimeoutMs?: number;
  registrationPollIntervalMs?: number;
}): Promise<void> {
  const {
    client,
    getHost,
    request,
    serverId,
    navigateToWorkspace,
    registrationWaitTimeoutMs,
    registrationPollIntervalMs,
  } = params;
  const executeAutomationCommand = getHost()?.browser?.executeAutomationCommand;

  if (request.command.command === "new_tab") {
    client.sendBrowserAutomationExecuteResponse({
      type: "browser.automation.execute.response",
      payload: await openBrowserTabForRequest({
        request,
        serverId,
        executeAutomationCommand,
        navigateToWorkspace,
        ...(registrationWaitTimeoutMs !== undefined ? { registrationWaitTimeoutMs } : {}),
        ...(registrationPollIntervalMs !== undefined ? { registrationPollIntervalMs } : {}),
      }),
    });
    return;
  }

  if (!executeAutomationCommand) {
    client.sendBrowserAutomationExecuteResponse({
      type: "browser.automation.execute.response",
      payload: browserAutomationFailure({
        requestId: request.requestId,
        code: "browser_unsupported",
        message: "Desktop browser automation is not available in this app runtime.",
      }),
    });
    return;
  }

  try {
    const payload = await executeAutomationCommand(request);
    client.sendBrowserAutomationExecuteResponse({
      type: "browser.automation.execute.response",
      payload: normalizeBridgePayload(request.requestId, payload),
    });
  } catch (error) {
    client.sendBrowserAutomationExecuteResponse({
      type: "browser.automation.execute.response",
      payload: normalizeThrownBridgeError(request.requestId, error),
    });
  }
}

async function openBrowserTabForRequest(params: {
  request: BrowserAutomationExecuteRequest;
  serverId?: string;
  executeAutomationCommand?: (
    request: BrowserAutomationExecuteRequest,
  ) => Promise<BrowserAutomationResponsePayload>;
  navigateToWorkspace: (serverId: string, workspaceId: string) => void;
  registrationWaitTimeoutMs?: number;
  registrationPollIntervalMs?: number;
}): Promise<BrowserAutomationResponsePayload> {
  const {
    request,
    serverId,
    executeAutomationCommand,
    navigateToWorkspace,
    registrationWaitTimeoutMs,
    registrationPollIntervalMs,
  } = params;
  const command = request.command as Extract<
    BrowserAutomationExecuteRequest["command"],
    { command: "new_tab" }
  >;
  const workspaceId = request.workspaceId ?? command.args.workspaceId;
  if (!serverId || !workspaceId) {
    return browserAutomationFailure({
      requestId: request.requestId,
      code: "browser_no_tab",
      message: "Cannot create a browser tab without a workspace context.",
    });
  }

  const url = command.args.url ?? "https://example.com";
  const { browserId, url: normalizedUrl } = createWorkspaceBrowser({ initialUrl: url });
  const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId });
  if (!workspaceKey) {
    return browserAutomationFailure({
      requestId: request.requestId,
      code: "browser_no_tab",
      message: "Cannot create a browser tab without a workspace context.",
    });
  }
  useWorkspaceLayoutStore.getState().openTabFocused(workspaceKey, { kind: "browser", browserId });
  navigateToWorkspace(serverId, workspaceId);

  if (executeAutomationCommand) {
    let registered = await waitForBrowserRegistration({
      request,
      browserId,
      workspaceId,
      executeAutomationCommand,
      ...(registrationWaitTimeoutMs !== undefined ? { timeoutMs: registrationWaitTimeoutMs } : {}),
      ...(registrationPollIntervalMs !== undefined
        ? { pollIntervalMs: registrationPollIntervalMs }
        : {}),
    });
    if (!registered) {
      await mountFallbackAutomationWebview({ browserId, workspaceId, url: normalizedUrl });
      registered = await waitForBrowserRegistration({
        request,
        browserId,
        workspaceId,
        executeAutomationCommand,
        ...(registrationWaitTimeoutMs !== undefined
          ? { timeoutMs: registrationWaitTimeoutMs }
          : {}),
        ...(registrationPollIntervalMs !== undefined
          ? { pollIntervalMs: registrationPollIntervalMs }
          : {}),
      });
    }
    if (!registered) {
      return browserAutomationFailure({
        requestId: request.requestId,
        code: "browser_timeout",
        message: `Timed out waiting for browser tab ${browserId} to register with desktop automation. Try browser_new_tab again.`,
        retryable: true,
      });
    }
  }

  return {
    requestId: request.requestId,
    ok: true,
    result: { command: "new_tab", browserId, workspaceId, url: normalizedUrl },
  };
}

async function waitForBrowserRegistration(params: {
  request: BrowserAutomationExecuteRequest;
  browserId: string;
  workspaceId: string;
  executeAutomationCommand: (
    request: BrowserAutomationExecuteRequest,
  ) => Promise<BrowserAutomationResponsePayload>;
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<boolean> {
  const deadline = Date.now() + (params.timeoutMs ?? 5_000);
  while (Date.now() < deadline) {
    const payload = await params.executeAutomationCommand({
      type: "browser.automation.execute.request",
      requestId: `${params.request.requestId}:list_tabs`,
      agentId: params.request.agentId,
      cwd: params.request.cwd,
      workspaceId: params.workspaceId,
      command: { command: "list_tabs", args: { workspaceId: params.workspaceId } },
    });
    if (payload.ok && payload.result.command === "list_tabs") {
      if (payload.result.tabs.some((tab) => tab.browserId === params.browserId)) {
        return true;
      }
    }
    await delay(params.pollIntervalMs ?? 100);
  }
  return false;
}

async function mountFallbackAutomationWebview(input: {
  browserId: string;
  workspaceId: string;
  url: string;
}): Promise<void> {
  if (!isWeb || typeof document === "undefined") {
    return;
  }
  if (document.querySelector(`[data-paseo-automation-browser-id="${input.browserId}"]`)) {
    return;
  }

  const webview = document.createElement("webview") as AutomationWebviewElement;
  webview.dataset.paseoAutomationBrowserId = input.browserId;
  webview.setAttribute("partition", `persist:paseo-browser-${input.browserId}`);
  webview.setAttribute("allowpopups", "true");
  webview.setAttribute("spellcheck", "false");
  webview.src = input.url;
  webview.style.position = "fixed";
  webview.style.left = "-10000px";
  webview.style.top = "0";
  webview.style.width = "1px";
  webview.style.height = "1px";
  webview.style.opacity = "0";
  webview.style.pointerEvents = "none";
  document.body.appendChild(webview);

  await getDesktopHost()?.browser?.registerWorkspaceBrowser?.({
    browserId: input.browserId,
    workspaceId: input.workspaceId,
  });
  await getDesktopHost()?.browser?.setWorkspaceActiveBrowser?.({
    workspaceId: input.workspaceId,
    browserId: input.browserId,
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBridgePayload(
  requestId: string,
  payload: BrowserAutomationResponsePayload,
): BrowserAutomationResponsePayload {
  return { ...payload, requestId } as BrowserAutomationResponsePayload;
}

function normalizeThrownBridgeError(
  requestId: string,
  error: unknown,
): BrowserAutomationFailurePayload {
  const typed = readTypedBrowserAutomationError(error);
  if (typed) {
    return browserAutomationFailure({ requestId, ...typed });
  }

  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("No handler registered")) {
    return browserAutomationFailure({
      requestId,
      code: "browser_unsupported",
      message: "Desktop browser automation is not implemented by this desktop build yet.",
    });
  }

  return browserAutomationFailure({
    requestId,
    code: "browser_unknown_error",
    message: message || "Desktop browser automation failed.",
  });
}

function readTypedBrowserAutomationError(
  value: unknown,
): { code: BrowserAutomationErrorCode; message: string; retryable?: boolean } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.code !== "string" || !record.code.startsWith("browser_")) {
    return null;
  }
  if (typeof record.message !== "string" || record.message.length === 0) {
    return null;
  }
  return {
    code: record.code as BrowserAutomationErrorCode,
    message: record.message,
    ...(typeof record.retryable === "boolean" ? { retryable: record.retryable } : {}),
  };
}

function browserAutomationFailure(params: {
  requestId: string;
  code: BrowserAutomationErrorCode;
  message: string;
  retryable?: boolean;
}): BrowserAutomationFailurePayload {
  return {
    requestId: params.requestId,
    ok: false,
    error: {
      code: params.code,
      message: params.message,
      retryable: params.retryable ?? false,
    },
  };
}
