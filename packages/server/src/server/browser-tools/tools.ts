import { z } from "zod";
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

const BrowserToolOutputSchema = z.object({
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
});

const BrowserRefInputSchema = z.string().regex(/^@e\d+$/);

export function registerBrowserTools(options: RegisterBrowserToolsOptions): void {
  options.registerTool(
    "browser_list_tabs",
    {
      title: "List browser tabs",
      description:
        "List open Paseo desktop browser tabs for this agent's workspace context. Use the returned browserId values exactly; do not use 'default'. If a tool omits browserId, it targets the active workspace tab.",
      inputSchema: {},
      outputSchema: BrowserToolOutputSchema,
    },
    async () => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
        command: {
          command: "list_tabs",
          args: context.workspaceId ? { workspaceId: context.workspaceId } : {},
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
        "Create and focus a new Paseo desktop browser tab in this agent's workspace. Optionally pass an http(s) URL to open immediately. Returns the new browserId; use that exact ID for later calls or omit browserId to use the active tab.",
      inputSchema: {
        url: z.string().url().optional(),
      },
      outputSchema: BrowserToolOutputSchema,
    },
    async ({ url }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
        command: {
          command: "new_tab",
          args: {
            ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
            ...(url ? { url } : {}),
          },
        },
      });
      return browserToolResult({ payload, context });
    },
  );

  options.registerTool(
    "browser_page_info",
    {
      title: "Get browser page info",
      description:
        "Get page info for a Paseo desktop browser tab. Omit browserId to use the active workspace tab. If you pass browserId, use a real ID returned by browser_list_tabs or browser_new_tab; never pass 'default'.",
      inputSchema: {
        browserId: z.string().min(1).optional(),
      },
      outputSchema: BrowserToolOutputSchema,
    },
    async ({ browserId }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
        ...(browserId ? { browserId } : {}),
        command: {
          command: "page_info",
          args: {
            ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
            ...(browserId ? { browserId } : {}),
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  options.registerTool(
    "browser_snapshot",
    {
      title: "Snapshot browser page",
      description:
        "Return a model-readable snapshot of the active Paseo desktop browser tab for this agent's workspace. Snapshot refs like @e1 are valid until the page changes or a new snapshot is taken.",
      inputSchema: {
        browserId: z.string().min(1).optional(),
      },
      outputSchema: BrowserToolOutputSchema,
    },
    async ({ browserId }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
        ...(browserId ? { browserId } : {}),
        command: {
          command: "snapshot",
          args: {
            ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
            ...(browserId ? { browserId } : {}),
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
        "Click an element ref from the latest browser_snapshot for this agent's workspace browser tab.",
      inputSchema: {
        ref: BrowserRefInputSchema,
        browserId: z.string().min(1).optional(),
      },
      outputSchema: BrowserToolOutputSchema,
    },
    async ({ ref, browserId }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
        ...(browserId ? { browserId } : {}),
        command: {
          command: "click",
          args: {
            ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
            ...(browserId ? { browserId } : {}),
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
        "Fill an input-like element ref from the latest browser_snapshot for this agent's workspace browser tab.",
      inputSchema: {
        ref: BrowserRefInputSchema,
        value: z.string(),
        browserId: z.string().min(1).optional(),
      },
      outputSchema: BrowserToolOutputSchema,
    },
    async ({ ref, value, browserId }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
        ...(browserId ? { browserId } : {}),
        command: {
          command: "fill",
          args: {
            ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
            ...(browserId ? { browserId } : {}),
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
        "Wait until the active Paseo desktop browser tab contains text or reaches a URL fragment.",
      inputSchema: {
        text: z.string().min(1).optional(),
        url: z.string().min(1).optional(),
        timeoutMs: z.number().int().positive().max(30_000).optional(),
        browserId: z.string().min(1).optional(),
      },
      outputSchema: BrowserToolOutputSchema,
    },
    async ({ text, url, timeoutMs, browserId }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
        ...(browserId ? { browserId } : {}),
        ...(timeoutMs ? { timeoutMs: timeoutMs + 1_000 } : {}),
        command: {
          command: "wait",
          args: {
            ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
            ...(browserId ? { browserId } : {}),
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
        "Type text into an element ref from the latest browser_snapshot, or into the currently focused browser element when ref is omitted.",
      inputSchema: {
        text: z.string(),
        ref: BrowserRefInputSchema.optional(),
        browserId: z.string().min(1).optional(),
      },
      outputSchema: BrowserToolOutputSchema,
    },
    async ({ text, ref, browserId }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
        ...(browserId ? { browserId } : {}),
        command: {
          command: "type",
          args: {
            ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
            ...(browserId ? { browserId } : {}),
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
        "Dispatch a keypress to an element ref from the latest browser_snapshot, or to the currently focused browser element when ref is omitted.",
      inputSchema: {
        key: z.string().min(1),
        ref: BrowserRefInputSchema.optional(),
        browserId: z.string().min(1).optional(),
      },
      outputSchema: BrowserToolOutputSchema,
    },
    async ({ key, ref, browserId }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
        ...(browserId ? { browserId } : {}),
        command: {
          command: "keypress",
          args: {
            ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
            ...(browserId ? { browserId } : {}),
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
      description: "Navigate the active Paseo desktop browser tab to a URL.",
      inputSchema: { url: z.string().min(1), browserId: z.string().min(1).optional() },
      outputSchema: BrowserToolOutputSchema,
    },
    async ({ url, browserId }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
        ...(browserId ? { browserId } : {}),
        command: {
          command: "navigate",
          args: {
            ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
            ...(browserId ? { browserId } : {}),
            url,
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  for (const name of ["browser_back", "browser_forward", "browser_reload"] as const) {
    const command = name.replace("browser_", "") as "back" | "forward" | "reload";
    options.registerTool(
      name,
      {
        title: `Browser ${command}`,
        description: `${command} the active Paseo desktop browser tab.`,
        inputSchema: { browserId: z.string().min(1).optional() },
        outputSchema: BrowserToolOutputSchema,
      },
      async ({ browserId }) => {
        const context = resolveBrowserToolContext(options);
        const payload = await options.broker.execute({
          agentId: context.agentId,
          cwd: context.cwd,
          ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
          ...(browserId ? { browserId } : {}),
          command: {
            command,
            args: {
              ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
              ...(browserId ? { browserId } : {}),
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
      description: "Capture a PNG screenshot of the active Paseo desktop browser tab.",
      inputSchema: { browserId: z.string().min(1).optional() },
      outputSchema: BrowserToolOutputSchema,
    },
    async ({ browserId }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
        ...(browserId ? { browserId } : {}),
        command: {
          command: "screenshot",
          args: {
            ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
            ...(browserId ? { browserId } : {}),
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  options.registerTool(
    "browser_full_page_screenshot",
    {
      title: "Capture full-page browser screenshot",
      description: "Capture a full-page PNG screenshot of a Paseo desktop browser tab.",
      inputSchema: { browserId: z.string().min(1).optional() },
      outputSchema: BrowserToolOutputSchema,
    },
    async ({ browserId }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
        ...(browserId ? { browserId } : {}),
        command: {
          command: "full_page_screenshot",
          args: {
            ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
            ...(browserId ? { browserId } : {}),
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  options.registerTool(
    "browser_pdf",
    {
      title: "Export browser page PDF",
      description: "Export the current Paseo desktop browser tab as a PDF.",
      inputSchema: {
        browserId: z.string().min(1).optional(),
        landscape: z.boolean().optional(),
        printBackground: z.boolean().default(true),
      },
      outputSchema: BrowserToolOutputSchema,
    },
    async ({ browserId, landscape, printBackground }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
        ...(browserId ? { browserId } : {}),
        command: {
          command: "pdf",
          args: {
            ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
            ...(browserId ? { browserId } : {}),
            ...(landscape !== undefined ? { landscape } : {}),
            printBackground: printBackground ?? true,
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  options.registerTool(
    "browser_download",
    {
      title: "Download file in browser",
      description: "Download a URL through the Paseo desktop browser session.",
      inputSchema: {
        url: z.string().min(1),
        fileName: z.string().min(1).optional(),
        browserId: z.string().min(1).optional(),
      },
      outputSchema: BrowserToolOutputSchema,
    },
    async ({ url, fileName, browserId }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
        ...(browserId ? { browserId } : {}),
        command: {
          command: "download",
          args: {
            ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
            ...(browserId ? { browserId } : {}),
            url,
            ...(fileName ? { fileName } : {}),
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
        "Set workspace files on a file input ref from the latest browser_snapshot. Paths must resolve inside the agent workspace.",
      inputSchema: {
        ref: BrowserRefInputSchema,
        filePaths: z.array(z.string().min(1)).min(1),
        browserId: z.string().min(1).optional(),
      },
      outputSchema: BrowserToolOutputSchema,
    },
    async ({ ref, filePaths, browserId }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
        ...(browserId ? { browserId } : {}),
        command: {
          command: "upload",
          args: {
            ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
            ...(browserId ? { browserId } : {}),
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
      name: "browser_focus",
      command: "focus",
      title: "Focus browser element",
      description: "Focus an element ref from the latest browser_snapshot.",
    },
    {
      name: "browser_clear",
      command: "clear",
      title: "Clear browser element",
      description: "Clear an input-like element ref from the latest browser_snapshot.",
    },
    {
      name: "browser_hover",
      command: "hover",
      title: "Hover browser element",
      description: "Hover an element ref from the latest browser_snapshot.",
    },
  ] as const) {
    options.registerTool(
      toolConfig.name,
      {
        title: toolConfig.title,
        description: toolConfig.description,
        inputSchema: { ref: BrowserRefInputSchema, browserId: z.string().min(1).optional() },
        outputSchema: BrowserToolOutputSchema,
      },
      async ({ ref, browserId }) => {
        const context = resolveBrowserToolContext(options);
        const payload = await options.broker.execute({
          agentId: context.agentId,
          cwd: context.cwd,
          ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
          ...(browserId ? { browserId } : {}),
          command: {
            command: toolConfig.command,
            args: {
              ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
              ...(browserId ? { browserId } : {}),
              ref,
            },
          },
        });
        return browserToolResult({ payload, context: { ...context, browserId } });
      },
    );
  }

  options.registerTool(
    "browser_check",
    {
      title: "Check browser control",
      description: "Set a checkbox or radio ref from the latest browser_snapshot.",
      inputSchema: {
        ref: BrowserRefInputSchema,
        checked: z.boolean().default(true),
        browserId: z.string().min(1).optional(),
      },
      outputSchema: BrowserToolOutputSchema,
    },
    async ({ ref, checked, browserId }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
        ...(browserId ? { browserId } : {}),
        command: {
          command: "check",
          args: {
            ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
            ...(browserId ? { browserId } : {}),
            ref,
            checked,
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  options.registerTool(
    "browser_select",
    {
      title: "Select browser option",
      description: "Set a select element ref from the latest browser_snapshot to a value.",
      inputSchema: {
        ref: BrowserRefInputSchema,
        value: z.string(),
        browserId: z.string().min(1).optional(),
      },
      outputSchema: BrowserToolOutputSchema,
    },
    async ({ ref, value, browserId }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
        ...(browserId ? { browserId } : {}),
        command: {
          command: "select",
          args: {
            ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
            ...(browserId ? { browserId } : {}),
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
        "Drag a source element ref onto a target element ref from the latest browser_snapshot.",
      inputSchema: {
        sourceRef: BrowserRefInputSchema,
        targetRef: BrowserRefInputSchema,
        browserId: z.string().min(1).optional(),
      },
      outputSchema: BrowserToolOutputSchema,
    },
    async ({ sourceRef, targetRef, browserId }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
        ...(browserId ? { browserId } : {}),
        command: {
          command: "drag",
          args: {
            ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
            ...(browserId ? { browserId } : {}),
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
        "Read recent console messages and browser performance network entries for a Paseo desktop browser tab.",
      inputSchema: {
        maxEntries: z.number().int().positive().max(200).optional(),
        browserId: z.string().min(1).optional(),
      },
      outputSchema: BrowserToolOutputSchema,
    },
    async ({ maxEntries, browserId }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
        ...(browserId ? { browserId } : {}),
        command: {
          command: "logs",
          args: {
            ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
            ...(browserId ? { browserId } : {}),
            maxEntries: maxEntries ?? 50,
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  options.registerTool(
    "browser_storage",
    {
      title: "Read browser storage",
      description:
        "Read cookies plus localStorage and sessionStorage for a Paseo desktop browser tab.",
      inputSchema: { browserId: z.string().min(1).optional() },
      outputSchema: BrowserToolOutputSchema,
    },
    async ({ browserId }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
        ...(browserId ? { browserId } : {}),
        command: {
          command: "storage",
          args: {
            ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
            ...(browserId ? { browserId } : {}),
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  options.registerTool(
    "browser_environment",
    {
      title: "Set/read browser environment",
      description: "Set or read viewport and geolocation for a Paseo desktop browser tab.",
      inputSchema: {
        viewport: z
          .object({
            width: z.number().int().positive(),
            height: z.number().int().positive(),
            deviceScaleFactor: z.number().positive().optional(),
          })
          .optional(),
        geolocation: z
          .object({
            latitude: z.number().min(-90).max(90),
            longitude: z.number().min(-180).max(180),
            accuracy: z.number().positive().optional(),
          })
          .optional(),
        browserId: z.string().min(1).optional(),
      },
      outputSchema: BrowserToolOutputSchema,
    },
    async ({ viewport, geolocation, browserId }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
        ...(browserId ? { browserId } : {}),
        command: {
          command: "environment",
          args: {
            ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
            ...(browserId ? { browserId } : {}),
            ...(viewport ? { viewport } : {}),
            ...(geolocation ? { geolocation } : {}),
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  options.registerTool(
    "browser_set_background",
    {
      title: "Set browser background",
      description:
        "Set the current page background color in the active Paseo desktop browser tab. Omit browserId to use the active workspace tab; pass a returned browserId only when targeting a specific tab.",
      inputSchema: {
        color: z.string().min(1),
        browserId: z.string().min(1).optional(),
      },
      outputSchema: BrowserToolOutputSchema,
    },
    async ({ color, browserId }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
        ...(browserId ? { browserId } : {}),
        command: {
          command: "set_background",
          args: {
            ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),
            ...(browserId ? { browserId } : {}),
            color,
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
  const cwd = callerAgent?.cwd;
  return {
    ...(options.callerAgentId ? { agentId: options.callerAgentId } : {}),
    ...(cwd ? { cwd, workspaceId: cwd } : {}),
  };
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
        result: payload.result,
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
  if (result.command !== "screenshot" && result.command !== "full_page_screenshot") {
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

  const storageSummary = summarizeBrowserStorageSuccess(payload.result);
  if (storageSummary) {
    return storageSummary;
  }

  const environmentSummary = summarizeBrowserEnvironmentSuccess(payload.result);
  if (environmentSummary) {
    return environmentSummary;
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
      return "No Paseo browser tabs are open. Call browser_new_tab to create one, then use the returned browserId or omit browserId for the active tab.";
    }
    const tabLines = payload.result.tabs.map((tab) => {
      const active = tab.isActive ? " active" : "";
      return `- browserId=${tab.browserId}${active} title=${JSON.stringify(tab.title || "Untitled")} url=${tab.url}`;
    });
    return [
      `Found ${count} Paseo browser tab${count === 1 ? "" : "s"}. Use these browserId values exactly; do not use 'default'. You may omit browserId to use the active tab.`,
      ...tabLines,
    ].join("\n");
  }

  if (payload.result.command === "new_tab") {
    return `Created browser tab browserId=${payload.result.browserId} url=${payload.result.url}. Use this browserId exactly, or omit browserId to use this active tab.`;
  }

  if (payload.result.command === "snapshot") {
    const count = payload.result.elements.length;
    return `Snapshot captured ${count} element${count === 1 ? "" : "s"}.`;
  }

  if (payload.result.command === "wait") {
    return `Browser wait matched ${payload.result.matched}.`;
  }

  if (payload.result.command === "page_info") {
    return `Current page browserId=${payload.result.tab.browserId}: ${payload.result.tab.title || "Untitled"} — ${payload.result.tab.url}`;
  }

  return `Browser ${payload.result.command} complete.`;
}

function summarizeBrowserMediaSuccess(
  result: Extract<BrowserToolsResponsePayload, { ok: true }>["result"],
): string | null {
  if (result.command === "screenshot") {
    return `Captured browser screenshot (${result.width}x${result.height}).`;
  }
  if (result.command === "full_page_screenshot") {
    return `Captured full-page browser screenshot (${result.width}x${result.height}).`;
  }
  if (result.command === "pdf") {
    return "Exported browser page PDF.";
  }
  if (result.command === "download") {
    return `Downloaded browser file to ${result.filePath}.`;
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

function summarizeBrowserStorageSuccess(
  result: Extract<BrowserToolsResponsePayload, { ok: true }>["result"],
): string | null {
  if (result.command !== "storage") {
    return null;
  }
  return `Read ${result.cookies.length} cookie${result.cookies.length === 1 ? "" : "s"}, ${result.localStorage.length} localStorage entr${result.localStorage.length === 1 ? "y" : "ies"}, and ${result.sessionStorage.length} sessionStorage entr${result.sessionStorage.length === 1 ? "y" : "ies"}.`;
}

function summarizeBrowserEnvironmentSuccess(
  result: Extract<BrowserToolsResponsePayload, { ok: true }>["result"],
): string | null {
  if (result.command !== "environment") {
    return null;
  }
  return `Browser environment viewport is ${result.viewport.width}x${result.viewport.height}.`;
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
  if (result.command === "focus") {
    return `Focused browser element ${result.ref}.`;
  }

  if (result.command === "clear") {
    return `Cleared browser element ${result.ref}.`;
  }

  if (result.command === "check") {
    return `${result.checked ? "Checked" : "Unchecked"} browser element ${result.ref}.`;
  }

  if (result.command === "select") {
    return `Selected ${result.value} in browser element ${result.ref}.`;
  }

  if (result.command === "hover") {
    return `Hovered browser element ${result.ref}.`;
  }

  if (result.command === "drag") {
    return `Dragged browser element ${result.sourceRef} to ${result.targetRef}.`;
  }

  if (result.command === "set_background") {
    return `Set browser page background to ${result.color}.`;
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
    case "browser_no_tab":
      return "No active browser tab is available. Call browser_new_tab to create one, then omit browserId for the active tab or use the returned browserId.";
    case "browser_timeout":
      return "The browser did not respond before the timeout. Try again or check the desktop app.";
    case "browser_unsupported":
      return "This desktop build does not support that browser automation request yet.";
    case "browser_stale_ref":
      return "That browser element reference is stale. Take a new browser snapshot and try again.";
    default:
      return error.message;
  }
}
