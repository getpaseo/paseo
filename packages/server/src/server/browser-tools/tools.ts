import { z } from "zod";
import { BrowserAutomationBrowserIdSchema } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import type { BrowserToolsBroker } from "./broker.js";
import type { BrowserToolsResponsePayload } from "./errors.js";
import type {
  PaseoToolConfig,
  PaseoToolExecutionContext,
  PaseoToolResult,
} from "../agent/tools/types.js";

interface CallerAgentContext {
  id: string;
  cwd: string;
  workspaceId?: string;
}

export interface RegisterBrowserToolsOptions {
  registerTool: (
    name: string,
    config: PaseoToolConfig,
    handler: (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Tool inputs are validated by the catalog before execution.
      input: any,
      context: PaseoToolExecutionContext,
    ) => Promise<PaseoToolResult>,
  ) => void;
  broker: Pick<BrowserToolsBroker, "execute">;
  callerAgentId?: string;
  resolveCallerAgent: () => CallerAgentContext | null;
}

const HTTP_URL_ONLY_MESSAGE = "URL must use http/https only";
const WORKSPACE_CONTEXT_MESSAGE =
  "This browser tool needs a workspace. Start the agent from a Paseo workspace before calling browser_new_tab or browser_list_tabs.";
const URL_WHITESPACE_PATTERN = /\s/;
const NON_HTTP_EXPLICIT_SCHEME_PATTERN = /^(?!https?:\/\/)[a-z][a-z0-9+.-]*:\/\//i;

const BrowserToolOutputSchema = {
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean(),
    })
    .optional(),
  context: z
    .object({
      agentId: z.string().optional(),
      cwd: z.string().optional(),
      workspaceId: z.string().optional(),
      browserId: z.string().optional(),
    })
    .optional(),
};

const BrowserHttpUrlInputSchema = z
  .string()
  .trim()
  .transform((value, context) => {
    const normalized = normalizeHttpUrlInput(value);
    if (!normalized) {
      context.addIssue({
        code: "custom",
        message: HTTP_URL_ONLY_MESSAGE,
      });
      return z.NEVER;
    }
    return normalized;
  });
const BrowserRefInputSchema = z.string().regex(/^@e\d+$/);
const BrowserWaitInputSchema = z
  .object({
    text: z.string().min(1).optional(),
    url: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive().max(30_000).optional(),
    browserId: BrowserAutomationBrowserIdSchema,
  })
  .refine((input) => Number(Boolean(input.text)) + Number(Boolean(input.url)) === 1, {
    message: "browser_wait requires exactly one of text or url",
  });

export function registerBrowserTools(options: RegisterBrowserToolsOptions): void {
  options.registerTool(
    "browser_list_tabs",
    {
      title: "List browser tabs",
      description:
        "List open Paseo desktop browser tabs for this agent's workspace. Use returned browserId values with tab-scoped tools.",
      inputSchema: {},
      outputSchema: BrowserToolOutputSchema,
    },
    async () => {
      const context = resolveBrowserToolContext(options);
      const missingWorkspace = requireWorkspaceContext(context);
      if (missingWorkspace) {
        return missingWorkspace;
      }
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
        command: {
          command: "list_tabs",
          args: {},
        },
      });
      return browserToolResult({ payload, context });
    },
  );

  options.registerTool(
    "browser_new_tab",
    {
      title: "Create browser tab",
      description:
        "Create and focus a new Paseo desktop browser tab in this agent's workspace. Pass an http(s) URL or a scheme-less host URL, which is treated as http; the returned browserId is used by tab-scoped tools.",
      inputSchema: {
        url: BrowserHttpUrlInputSchema.optional(),
      },
      outputSchema: BrowserToolOutputSchema,
    },
    async ({ url }) => {
      const context = resolveBrowserToolContext(options);
      const missingWorkspace = requireWorkspaceContext(context);
      if (missingWorkspace) {
        return missingWorkspace;
      }
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
        command: {
          command: "new_tab",
          args: url ? { url } : {},
        },
      });
      return browserToolResult({ payload, context });
    },
  );

  options.registerTool(
    "browser_snapshot",
    {
      title: "Snapshot browser page",
      description:
        "Return a model-readable snapshot of a Paseo desktop browser tab. Use browserId from browser_new_tab or browser_list_tabs; refs come from the latest browser_snapshot of the same tab and expire when the page changes.",
      inputSchema: {
        browserId: BrowserAutomationBrowserIdSchema,
      },
      outputSchema: BrowserToolOutputSchema,
    },
    async ({ browserId }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        command: {
          command: "snapshot",
          args: {
            browserId,
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  options.registerTool(
    "browser_click",
    {
      title: "Click browser element",
      description:
        "Click an element in a Paseo desktop browser tab. Use browserId from browser_new_tab or browser_list_tabs; refs come from the latest browser_snapshot of the same tab and expire when the page changes.",
      inputSchema: {
        ref: BrowserRefInputSchema,
        browserId: BrowserAutomationBrowserIdSchema,
      },
      outputSchema: BrowserToolOutputSchema,
    },
    async ({ ref, browserId }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        command: {
          command: "click",
          args: {
            browserId,
            ref,
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  options.registerTool(
    "browser_fill",
    {
      title: "Fill browser element",
      description:
        "Fill an input-like element in a Paseo desktop browser tab. Use browserId from browser_new_tab or browser_list_tabs; refs come from the latest browser_snapshot of the same tab and expire when the page changes.",
      inputSchema: {
        ref: BrowserRefInputSchema,
        value: z.string(),
        browserId: BrowserAutomationBrowserIdSchema,
      },
      outputSchema: BrowserToolOutputSchema,
    },
    async ({ ref, value, browserId }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        command: {
          command: "fill",
          args: {
            browserId,
            ref,
            value,
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  options.registerTool(
    "browser_wait",
    {
      title: "Wait for browser condition",
      description:
        "Wait until a Paseo desktop browser tab contains text or reaches a URL fragment. Use browserId from browser_new_tab or browser_list_tabs; waits up to 5s by default on the desktop side.",
      inputSchema: BrowserWaitInputSchema,
      outputSchema: BrowserToolOutputSchema,
    },
    async ({ text, url, timeoutMs, browserId }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        ...(timeoutMs ? { timeoutMs: timeoutMs + 1_000 } : {}),
        command: {
          command: "wait",
          args: {
            browserId,
            ...(text ? { text } : {}),
            ...(url ? { url } : {}),
            ...(timeoutMs ? { timeoutMs } : {}),
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  options.registerTool(
    "browser_type",
    {
      title: "Type into browser",
      description:
        "Type text into an element, or into the focused element when ref is omitted. Use browserId from browser_new_tab or browser_list_tabs; refs come from the latest browser_snapshot of the same tab and expire when the page changes.",
      inputSchema: {
        text: z.string(),
        ref: BrowserRefInputSchema.optional(),
        browserId: BrowserAutomationBrowserIdSchema,
      },
      outputSchema: BrowserToolOutputSchema,
    },
    async ({ text, ref, browserId }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        command: {
          command: "type",
          args: {
            browserId,
            ...(ref ? { ref } : {}),
            text,
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  options.registerTool(
    "browser_keypress",
    {
      title: "Press browser key",
      description:
        "Dispatch a keypress to an element, or to the focused element when ref is omitted. Use browserId from browser_new_tab or browser_list_tabs; refs come from the latest browser_snapshot of the same tab and expire when the page changes.",
      inputSchema: {
        key: z.string().min(1),
        ref: BrowserRefInputSchema.optional(),
        browserId: BrowserAutomationBrowserIdSchema,
      },
      outputSchema: BrowserToolOutputSchema,
    },
    async ({ key, ref, browserId }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        command: {
          command: "keypress",
          args: {
            browserId,
            ...(ref ? { ref } : {}),
            key,
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  options.registerTool(
    "browser_navigate",
    {
      title: "Navigate browser",
      description:
        "Navigate a Paseo desktop browser tab to a URL. Use browserId from browser_new_tab or browser_list_tabs; pass an http(s) URL or a scheme-less host URL, which is treated as http.",
      inputSchema: { url: BrowserHttpUrlInputSchema, browserId: BrowserAutomationBrowserIdSchema },
      outputSchema: BrowserToolOutputSchema,
    },
    async ({ url, browserId }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        command: {
          command: "navigate",
          args: {
            browserId,
            url,
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  for (const toolConfig of [
    {
      name: "browser_back",
      command: "back",
      title: "Browser back",
      description:
        "Go back in a Paseo desktop browser tab. Use browserId from browser_new_tab or browser_list_tabs.",
    },
    {
      name: "browser_forward",
      command: "forward",
      title: "Browser forward",
      description:
        "Go forward in a Paseo desktop browser tab. Use browserId from browser_new_tab or browser_list_tabs.",
    },
    {
      name: "browser_reload",
      command: "reload",
      title: "Browser reload",
      description:
        "Reload a Paseo desktop browser tab. Use browserId from browser_new_tab or browser_list_tabs.",
    },
  ] as const) {
    options.registerTool(
      toolConfig.name,
      {
        title: toolConfig.title,
        description: toolConfig.description,
        inputSchema: { browserId: BrowserAutomationBrowserIdSchema },
        outputSchema: BrowserToolOutputSchema,
      },
      async ({ browserId }) => {
        const context = resolveBrowserToolContext(options);
        const payload = await options.broker.execute({
          agentId: context.agentId,
          cwd: context.cwd,
          ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

          command: {
            command: toolConfig.command,
            args: {
              browserId,
            },
          },
        });
        return browserToolResult({ payload, context: { ...context, browserId } });
      },
    );
  }

  options.registerTool(
    "browser_screenshot",
    {
      title: "Capture browser screenshot",
      description:
        "Capture a PNG screenshot of a Paseo desktop browser tab. Use browserId from browser_new_tab or browser_list_tabs. Set fullPage to true to capture the full page.",
      inputSchema: {
        browserId: BrowserAutomationBrowserIdSchema,
        fullPage: z.boolean().default(false),
      },
      outputSchema: BrowserToolOutputSchema,
    },
    async ({ browserId, fullPage }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        command: {
          command: "screenshot",
          args: {
            browserId,
            fullPage: fullPage ?? false,
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  options.registerTool(
    "browser_upload",
    {
      title: "Upload files in browser",
      description:
        "Set workspace files on a file input in a Paseo desktop browser tab. Use browserId from browser_new_tab or browser_list_tabs; refs come from the latest browser_snapshot of the same tab and expire when the page changes.",
      inputSchema: {
        ref: BrowserRefInputSchema,
        filePaths: z.array(z.string().min(1)).min(1),
        browserId: BrowserAutomationBrowserIdSchema,
      },
      outputSchema: BrowserToolOutputSchema,
    },
    async ({ ref, filePaths, browserId }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        command: {
          command: "upload",
          args: {
            browserId,
            ref,
            filePaths,
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  for (const toolConfig of [
    {
      name: "browser_hover",
      command: "hover",
      title: "Hover browser element",
      description:
        "Hover an element in a Paseo desktop browser tab. Use browserId from browser_new_tab or browser_list_tabs; refs come from the latest browser_snapshot of the same tab and expire when the page changes.",
    },
  ] as const) {
    options.registerTool(
      toolConfig.name,
      {
        title: toolConfig.title,
        description: toolConfig.description,
        inputSchema: { ref: BrowserRefInputSchema, browserId: BrowserAutomationBrowserIdSchema },
        outputSchema: BrowserToolOutputSchema,
      },
      async ({ ref, browserId }) => {
        const context = resolveBrowserToolContext(options);
        const payload = await options.broker.execute({
          agentId: context.agentId,
          cwd: context.cwd,
          ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

          command: {
            command: toolConfig.command,
            args: {
              browserId,
              ref,
            },
          },
        });
        return browserToolResult({ payload, context: { ...context, browserId } });
      },
    );
  }

  options.registerTool(
    "browser_select",
    {
      title: "Select browser option",
      description:
        "Set a select element in a Paseo desktop browser tab to a value. Use browserId from browser_new_tab or browser_list_tabs; refs come from the latest browser_snapshot of the same tab and expire when the page changes.",
      inputSchema: {
        ref: BrowserRefInputSchema,
        value: z.string(),
        browserId: BrowserAutomationBrowserIdSchema,
      },
      outputSchema: BrowserToolOutputSchema,
    },
    async ({ ref, value, browserId }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        command: {
          command: "select",
          args: {
            browserId,
            ref,
            value,
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  options.registerTool(
    "browser_drag",
    {
      title: "Drag browser element",
      description:
        "Drag one element onto another in a Paseo desktop browser tab. Use browserId from browser_new_tab or browser_list_tabs; refs come from the latest browser_snapshot of the same tab and expire when the page changes.",
      inputSchema: {
        sourceRef: BrowserRefInputSchema,
        targetRef: BrowserRefInputSchema,
        browserId: BrowserAutomationBrowserIdSchema,
      },
      outputSchema: BrowserToolOutputSchema,
    },
    async ({ sourceRef, targetRef, browserId }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        command: {
          command: "drag",
          args: {
            browserId,
            sourceRef,
            targetRef,
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  options.registerTool(
    "browser_logs",
    {
      title: "Read browser logs",
      description:
        "Read recent console messages and browser performance network entries for a Paseo desktop browser tab. Use browserId from browser_new_tab or browser_list_tabs; maxEntries defaults to 50.",
      inputSchema: {
        maxEntries: z.number().int().positive().max(200).optional(),
        browserId: BrowserAutomationBrowserIdSchema,
      },
      outputSchema: BrowserToolOutputSchema,
    },
    async ({ maxEntries, browserId }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        command: {
          command: "logs",
          args: {
            browserId,
            maxEntries: maxEntries ?? 50,
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );
}

function resolveBrowserToolContext(options: RegisterBrowserToolsOptions): {
  agentId?: string;
  cwd?: string;
  workspaceId?: string;
} {
  const callerAgent = options.resolveCallerAgent();
  return {
    ...(options.callerAgentId ? { agentId: options.callerAgentId } : {}),
    ...(callerAgent?.cwd ? { cwd: callerAgent.cwd } : {}),
    ...(callerAgent?.workspaceId ? { workspaceId: callerAgent.workspaceId } : {}),
  };
}

function normalizeHttpUrlInput(value: string): string | null {
  if (value.length === 0) {
    return null;
  }

  const explicitHttpUrl = /^https?:\/\//i.test(value);
  if (explicitHttpUrl) {
    return isValidHttpUrl(value) ? value : null;
  }

  if (URL_WHITESPACE_PATTERN.test(value) || NON_HTTP_EXPLICIT_SCHEME_PATTERN.test(value)) {
    return null;
  }

  const normalized = `http://${value}`;
  return isValidHttpUrl(normalized) ? normalized : null;
}

function isValidHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function requireWorkspaceContext(context: {
  agentId?: string;
  cwd?: string;
  workspaceId?: string;
}): PaseoToolResult | null {
  if (context.workspaceId) {
    return null;
  }

  return browserToolResult({
    payload: {
      requestId: "browser-tools-workspace-context",
      ok: false,
      error: {
        code: "browser_denied",
        message: WORKSPACE_CONTEXT_MESSAGE,
        retryable: false,
      },
    },
    context,
  });
}

function browserToolResult(params: {
  payload: BrowserToolsResponsePayload;
  context: { agentId?: string; cwd?: string; workspaceId?: string; browserId?: string };
}): PaseoToolResult {
  const { payload, context } = params;
  if (payload.ok) {
    return {
      content: browserToolSuccessContent(payload),
      structuredContent: {
        ok: true,
        result: browserToolStructuredResult(payload.result),
        context,
      },
    };
  }

  return {
    content: [{ type: "text", text: summarizeBrowserError(payload.error) }],
    structuredContent: {
      ok: false,
      error: payload.error,
      context,
    },
  };
}

function browserToolStructuredResult(
  result: Extract<BrowserToolsResponsePayload, { ok: true }>["result"],
): Extract<BrowserToolsResponsePayload, { ok: true }>["result"] | Record<string, unknown> {
  if (result.command !== "screenshot") {
    return result;
  }

  const { dataBase64: _dataBase64, ...metadata } = result;
  return metadata;
}

function browserToolSuccessContent(
  payload: Extract<BrowserToolsResponsePayload, { ok: true }>,
): PaseoToolResult["content"] {
  const textContent = { type: "text" as const, text: summarizeBrowserSuccess(payload) };
  const imageContent = browserToolImageContent(payload.result);
  return imageContent ? [textContent, imageContent] : [textContent];
}

function browserToolImageContent(
  result: Extract<BrowserToolsResponsePayload, { ok: true }>["result"],
): PaseoToolResult["content"][number] | null {
  if (result.command !== "screenshot") {
    return null;
  }

  return {
    type: "image",
    data: result.dataBase64,
    mimeType: result.mimeType,
  };
}

function summarizeBrowserSuccess(
  payload: Extract<BrowserToolsResponsePayload, { ok: true }>,
): string {
  const controlSummary = summarizeBrowserControlSuccess(payload.result);
  if (controlSummary) {
    return controlSummary;
  }

  const refActionSummary = summarizeBrowserRefActionSuccess(payload.result);
  if (refActionSummary) {
    return refActionSummary;
  }

  const diagnosticsSummary = summarizeBrowserDiagnosticsSuccess(payload.result);
  if (diagnosticsSummary) {
    return diagnosticsSummary;
  }

  const keyboardSummary = summarizeBrowserKeyboardSuccess(payload.result);
  if (keyboardSummary) {
    return keyboardSummary;
  }

  const navigationSummary = summarizeBrowserNavigationSuccess(payload.result);
  if (navigationSummary) {
    return navigationSummary;
  }

  const mediaSummary = summarizeBrowserMediaSuccess(payload.result);
  if (mediaSummary) {
    return mediaSummary;
  }

  if (payload.result.command === "list_tabs") {
    const count = payload.result.tabs.length;
    if (count === 0) {
      return "No Paseo browser tabs are open. Call browser_new_tab to create one.";
    }
    const tabLines = payload.result.tabs.map((tab) => {
      const active = tab.isActive ? " active" : "";
      return `- browserId=${tab.browserId}${active} title=${JSON.stringify(tab.title || "Untitled")} url=${tab.url}`;
    });
    return [
      `Found ${count} Paseo browser tab${count === 1 ? "" : "s"}. Use these browserId values for tab-scoped browser tools.`,
      ...tabLines,
    ].join("\n");
  }

  if (payload.result.command === "new_tab") {
    return `Created browser tab browserId=${payload.result.browserId} url=${payload.result.url}. Use this browserId for tab-scoped browser tools.`;
  }

  if (payload.result.command === "snapshot") {
    const count = payload.result.elements.length;
    return `Snapshot captured ${count} element${count === 1 ? "" : "s"}.`;
  }

  if (payload.result.command === "wait") {
    return `Browser wait matched ${payload.result.matched}.`;
  }

  return `Browser ${payload.result.command} complete.`;
}

function summarizeBrowserMediaSuccess(
  result: Extract<BrowserToolsResponsePayload, { ok: true }>["result"],
): string | null {
  if (result.command === "screenshot") {
    return `Captured browser screenshot (${result.width}x${result.height}).`;
  }
  if (result.command === "upload") {
    const count = result.filePaths.length;
    return `Uploaded ${count} file${count === 1 ? "" : "s"} to browser element ${result.ref}.`;
  }
  return null;
}

function summarizeBrowserKeyboardSuccess(
  result: Extract<BrowserToolsResponsePayload, { ok: true }>["result"],
): string | null {
  if (result.command === "type") {
    return result.ref
      ? `Typed into browser element ${result.ref}.`
      : "Typed into the focused browser element.";
  }

  if (result.command === "keypress") {
    return result.ref
      ? `Pressed ${result.key} on browser element ${result.ref}.`
      : `Pressed ${result.key} in the browser.`;
  }

  return null;
}

function summarizeBrowserNavigationSuccess(
  result: Extract<BrowserToolsResponsePayload, { ok: true }>["result"],
): string | null {
  if (result.command === "navigate") {
    return `Navigated browser to ${result.url}.`;
  }

  if (result.command === "back" || result.command === "forward" || result.command === "reload") {
    return `Browser ${result.command} complete.`;
  }

  return null;
}

function summarizeBrowserDiagnosticsSuccess(
  result: Extract<BrowserToolsResponsePayload, { ok: true }>["result"],
): string | null {
  if (result.command !== "logs") {
    return null;
  }
  const consoleCount = result.console.length;
  const networkCount = result.network.length;
  return `Read ${consoleCount} console log${consoleCount === 1 ? "" : "s"} and ${networkCount} network entr${networkCount === 1 ? "y" : "ies"}.`;
}

function summarizeBrowserRefActionSuccess(
  result: Extract<BrowserToolsResponsePayload, { ok: true }>["result"],
): string | null {
  if (result.command === "click") {
    return `Clicked browser element ${result.ref}.`;
  }

  if (result.command === "fill") {
    return `Filled browser element ${result.ref}.`;
  }

  return null;
}

function summarizeBrowserControlSuccess(
  result: Extract<BrowserToolsResponsePayload, { ok: true }>["result"],
): string | null {
  if (result.command === "select") {
    return `Selected ${result.value} in browser element ${result.ref}.`;
  }

  if (result.command === "hover") {
    return `Hovered browser element ${result.ref}.`;
  }

  if (result.command === "drag") {
    return `Dragged browser element ${result.sourceRef} to ${result.targetRef}.`;
  }

  return null;
}

function summarizeBrowserError(
  error: Extract<BrowserToolsResponsePayload, { ok: false }>["error"],
): string {
  switch (error.code) {
    case "browser_disabled":
      return "Browser tools are disabled. Enable desktop browser tools on the host, then try again.";
    case "browser_no_desktop":
      return "No desktop browser automation client is connected. Open the Paseo desktop app and try again.";
    case "browser_timeout":
      return "The browser did not respond before the timeout. Try again or check the desktop app.";
    case "screenshot_no_frame":
      return error.message;
    case "browser_unsupported":
      return "This desktop build does not support that browser automation request yet.";
    case "browser_stale_ref":
      return "That browser element reference is stale. Take a new browser snapshot and try again.";
    default:
      return error.message;
  }
}
