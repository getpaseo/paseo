import { z } from "zod";
import { BrowserAutomationBrowserIdSchema } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import {
  PaseoRecipeStepSchema,
  type PaseoRecipeStep,
} from "@getpaseo/protocol/paseo-config-schema";
import type { BrowserHandoff } from "@getpaseo/protocol/browser-activity/rpc-schemas";
import type { BrowserActivityHub } from "./browser-activity.js";
import type { BrowserToolsBroker } from "./broker.js";
import { ensureValidJson } from "../json-utils.js";
import type { VerifySession } from "../verify/verify-session.js";
import { browserToolsFailure, type BrowserToolsResponsePayload } from "./errors.js";
import {
  JevBrowserGoalRunner,
  type JevBrowserGoalInput,
  type JevBrowserGoalResult,
} from "./jev-goal-runner.js";
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
  goalRunner?: Pick<JevBrowserGoalRunner, "run">;
  verify?: Pick<VerifySession, "runForAgent">;
  /** Present only for a calling agent that can receive the follow-up. */
  handoff?: {
    hub: Pick<BrowserActivityHub, "activeHandoff" | "refuseHandedOff" | "startHandoff">;
    onEnd: (handoff: BrowserHandoff) => void;
  };
  callerAgentId?: string;
  resolveCallerAgent: () => CallerAgentContext | null;
}

const HTTP_URL_ONLY_MESSAGE = "URL must use http/https only";
const WORKSPACE_CONTEXT_MESSAGE =
  "This browser tool needs a workspace. Start the agent from a Paseo workspace before calling browser_new_tab or browser_list_tabs.";
const URL_WHITESPACE_PATTERN = /\s/;
const NON_HTTP_EXPLICIT_SCHEME_PATTERN = /^(?!https?:\/\/)[a-z][a-z0-9+.-]*:\/\//i;

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
const BrowserClickButtonInputSchema = z.enum(["left", "right", "middle"]);
const BrowserClickModifierInputSchema = z.enum(["Alt", "Control", "Meta", "Shift"]);
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
const BrowserGoalVerificationSchema = z.union([
  z.object({ text: z.string().min(1) }).strict(),
  z.object({ url: z.string().min(1) }).strict(),
]);
const BrowserGoalInputSchema = z
  .object({
    goal: z.string().trim().min(1),
    browserId: BrowserAutomationBrowserIdSchema.optional(),
    url: BrowserHttpUrlInputSchema.optional(),
    values: z
      .record(
        z.string().min(1),
        z
          .object({
            env: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
            description: z.string().min(1).optional(),
          })
          .strict(),
      )
      .optional(),
    verify: z.array(BrowserGoalVerificationSchema).min(1),
    maxSteps: z.number().int().min(1).max(30).optional(),
    minConfidence: z.number().min(0).max(1).optional(),
  })
  .refine((input) => Boolean(input.browserId || input.url), {
    message: "browser_goal requires browserId or url",
  });

export function registerBrowserTools(options: RegisterBrowserToolsOptions): void {
  if (options.verify) {
    const verify = options.verify;
    options.registerTool(
      "browser_test",
      {
        title: "Test in Paseo's testing engine",
        description:
          "Paseo's testing engine. Use it first for every UI, end-to-end, or 'does it work in the browser' check instead of driving browser_* tools step by step. Call with no arguments to list the workspace's saved recipes; pass `recipe` to run one; or pass `steps` for an ad-hoc run. Steps run inside the daemon without model tokens: navigate (url, or service + path), click/fill/assert-visible (role + name), wait-text, assert-text, assert-console-errors, assert-failed-requests, screenshot, ensure-authenticated. Use a `goal` step ({ action: \"goal\", goal, verify: [{ text } | { url }] }) for parts you cannot script: Jev drives them in fast bounded steps. Returns only pass/fail, checks, log counts, and an evidence reference; open the browser_* tools only to debug a failed run. Pass `saveAs` with ad-hoc steps to store a passing run as a recipe in paseo.json, so the next run is fully scripted.",
        inputSchema: {
          recipe: z.string().trim().min(1).optional(),
          steps: z.array(PaseoRecipeStepSchema).min(1).max(60).optional(),
          params: z.record(z.string(), z.string()).optional(),
          saveAs: z
            .string()
            .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
            .optional()
            .describe("With steps: save the run as this recipe in paseo.json if it passes."),
        },
      },
      async (input: {
        recipe?: string;
        steps?: PaseoRecipeStep[];
        params?: Record<string, string>;
        saveAs?: string;
      }) => {
        const context = resolveBrowserToolContext(options);
        if (!context.workspaceId) {
          return requireWorkspaceContext(context) as PaseoToolResult;
        }
        try {
          const outcome = await verify.runForAgent({ workspaceId: context.workspaceId, ...input });
          const structuredContent = ensureValidJson(
            outcome.kind === "list"
              ? { recipes: outcome.recipes }
              : {
                  ...outcome.result,
                  ...(outcome.savedRecipe ? { savedRecipe: outcome.savedRecipe } : {}),
                },
          );
          return {
            content: [{ type: "text", text: JSON.stringify(structuredContent) }],
            structuredContent,
            ...(outcome.kind === "run" && outcome.result.status === "fail"
              ? { isError: true }
              : {}),
          };
        } catch (error) {
          return {
            content: [
              { type: "text", text: error instanceof Error ? error.message : "Test run failed." },
            ],
            isError: true,
          };
        }
      },
    );
  }

  options.registerTool(
    "browser_list_tabs",
    {
      title: "List browser tabs",
      description:
        "List open Paseo browser tabs for this agent's workspace across connected browser automation hosts. Use returned browserId values with tab-scoped tools.",
      inputSchema: {},
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
        "TESTING: for any test, E2E, or verification of a flow, call browser_test instead — one call replaces this step-by-step loop. Use this tool for debugging a failed browser_test run or non-test browsing. Create a new Paseo browser tab in this agent's workspace on the most recently connected browser automation host, opened in the background without switching the user's view. Pass the final target URL here, with any token, query, or hash, so the page opens directly; opening a blank tab and navigating afterwards loses one-time tokens. http(s) and scheme-less host URLs (treated as http) are accepted; the returned browserId is used by tab-scoped tools.",
      inputSchema: {
        url: BrowserHttpUrlInputSchema.optional(),
      },
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
    "browser_goal",
    {
      title: "Run browser goal with Jev",
      description:
        "Run a bounded Jev decision loop against an existing Paseo browser tab or a new http(s) URL. Paseo sends the page's accessibility element summary, goal, and recent action metadata to TypeSafe, but not screenshots or values loaded locally from environment-variable names in the values map. Every successful run must pass the explicit text or URL checks in verify.",
      inputSchema: BrowserGoalInputSchema,
    },
    async (input: JevBrowserGoalInput) => {
      const context = resolveBrowserToolContext(options);
      const missingWorkspace = requireWorkspaceContext(context);
      if (missingWorkspace) {
        return missingWorkspace;
      }

      try {
        const runner = options.goalRunner ?? new JevBrowserGoalRunner({ broker: options.broker });
        const result = await runner.run(input, context);
        return browserGoalToolResult(result, context);
      } catch (error) {
        return browserToolResult({
          payload: {
            requestId: "browser-goal",
            ok: false,
            error: {
              code: "browser_unknown_error",
              message: error instanceof Error ? error.message : "Browser goal failed.",
              retryable: false,
            },
          },
          context,
        });
      }
    },
  );

  if (options.handoff) {
    const handoff = options.handoff;
    options.registerTool(
      "browser_handoff",
      {
        title: "Hand browser tab to the user",
        description:
          'Hand a Paseo browser tab to the user for a step only they can do: logins, 2FA or verification codes, CAPTCHAs, payments, and consent screens. Never ask for passwords, codes, or card details in chat, and never type them yourself. The call returns immediately; the user then controls the tab and every browser tool on it fails until they finish. End your turn right after this call and tell the user what to do in the tab. You will receive a message with the tab\'s URL and title when they finish or cancel. Use browserId from browser_new_tab or browser_list_tabs; reason is a short instruction shown to the user, such as "Sign in to example.com".',
        inputSchema: {
          browserId: BrowserAutomationBrowserIdSchema,
          reason: z.string().trim().min(1).max(200),
        },
      },
      async ({ browserId, reason }: { browserId: string; reason: string }) => {
        const context = resolveBrowserToolContext(options);
        const { agentId, workspaceId } = context;
        if (!workspaceId || !agentId) {
          return browserToolResult({
            payload: browserToolsFailure({
              requestId: "browser-handoff",
              code: "browser_denied",
              message: "browser_handoff needs an agent that runs in a Paseo workspace.",
            }),
            context,
          });
        }
        const refused = handoff.hub.refuseHandedOff({ command: "snapshot", args: { browserId } });
        if (refused) {
          return browserToolResult({ payload: refused, context: { ...context, browserId } });
        }
        const tabs = await options.broker.execute({
          agentId,
          workspaceId,
          ...(context.cwd ? { cwd: context.cwd } : {}),
          command: { command: "list_tabs", args: {} },
        });
        if (!tabs.ok) {
          return browserToolResult({ payload: tabs, context: { ...context, browserId } });
        }
        const isOpen =
          tabs.result.command === "list_tabs" &&
          tabs.result.tabs.some((tab) => tab.browserId === browserId);
        if (!isOpen) {
          return browserToolResult({
            payload: browserToolsFailure({
              requestId: "browser-handoff",
              code: "browser_tab_not_found",
              message: `Browser tab ${browserId} is not open in this workspace. Call browser_list_tabs and use one of the returned browserId values.`,
            }),
            context: { ...context, browserId },
          });
        }
        const started = handoff.hub.startHandoff({
          workspaceId,
          browserId,
          agentId,
          reason,
          onEnd: handoff.onEnd,
        });
        if (!started) {
          return browserToolResult({
            payload: browserToolsFailure({
              requestId: "browser-handoff",
              code: "browser_denied",
              message: "This browser tab is already handed off to the user.",
            }),
            context: { ...context, browserId },
          });
        }
        return {
          content: [
            {
              type: "text",
              text: `Handed browser tab ${browserId} to the user (handoffId=${started.handoffId}): "${reason}". The user controls the tab now and browser tools on it fail until they finish. End your turn now and tell the user what to do in the tab; you will receive a message when they finish or cancel.`,
            },
          ],
          structuredContent: {
            ok: true,
            handoffId: started.handoffId,
            browserId,
            reason,
            status: started.status,
            context,
          },
        };
      },
    );
  }

  options.registerTool(
    "browser_snapshot",
    {
      title: "Snapshot browser page",
      description:
        "TESTING: for any test, E2E, or verification of a flow, call browser_test instead — one call replaces this step-by-step loop. Use this tool for debugging a failed browser_test run or non-test browsing. Return a model-readable snapshot of a Paseo browser tab. Use browserId from browser_new_tab or browser_list_tabs; refs come from the latest browser_snapshot of the same tab and expire when the page changes.",
      inputSchema: {
        browserId: BrowserAutomationBrowserIdSchema,
      },
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
        "TESTING: for any test, E2E, or verification of a flow, call browser_test instead — one call replaces this step-by-step loop. Use this tool for debugging a failed browser_test run or non-test browsing. Click an element in a Paseo browser tab. Use browserId from browser_new_tab or browser_list_tabs; refs come from the latest browser_snapshot of the same tab and expire when the page changes.",
      inputSchema: {
        ref: BrowserRefInputSchema,
        browserId: BrowserAutomationBrowserIdSchema,
        button: BrowserClickButtonInputSchema.optional(),
        doubleClick: z.boolean().optional(),
        modifiers: z.array(BrowserClickModifierInputSchema).optional(),
      },
    },
    async ({ ref, browserId, button, doubleClick, modifiers }) => {
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
            button: button ?? "left",
            doubleClick: doubleClick ?? false,
            modifiers: modifiers ?? [],
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
        "Fill an input-like element in a Paseo browser tab. Use browserId from browser_new_tab or browser_list_tabs; refs come from the latest browser_snapshot of the same tab and expire when the page changes.",
      inputSchema: {
        ref: BrowserRefInputSchema,
        value: z.string(),
        browserId: BrowserAutomationBrowserIdSchema,
      },
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
        "Wait until a Paseo browser tab contains text or reaches a URL fragment. Use browserId from browser_new_tab or browser_list_tabs; waits up to 5s by default on the browser host.",
      inputSchema: BrowserWaitInputSchema,
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
        "TESTING: for any test, E2E, or verification of a flow, call browser_test instead — one call replaces this step-by-step loop. Use this tool for debugging a failed browser_test run or non-test browsing. Navigate a Paseo browser tab to a URL. Use browserId from browser_new_tab or browser_list_tabs; pass an http(s) URL or a scheme-less host URL, which is treated as http.",
      inputSchema: { url: BrowserHttpUrlInputSchema, browserId: BrowserAutomationBrowserIdSchema },
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
        "Go back in a Paseo browser tab. Use browserId from browser_new_tab or browser_list_tabs.",
    },
    {
      name: "browser_forward",
      command: "forward",
      title: "Browser forward",
      description:
        "Go forward in a Paseo browser tab. Use browserId from browser_new_tab or browser_list_tabs.",
    },
    {
      name: "browser_reload",
      command: "reload",
      title: "Browser reload",
      description:
        "Reload a Paseo browser tab. Use browserId from browser_new_tab or browser_list_tabs.",
    },
  ] as const) {
    options.registerTool(
      toolConfig.name,
      {
        title: toolConfig.title,
        description: toolConfig.description,
        inputSchema: { browserId: BrowserAutomationBrowserIdSchema },
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
        "Capture a PNG screenshot of a Paseo browser tab. Use browserId from browser_new_tab or browser_list_tabs. Set fullPage to true to capture the full page. The screenshot is stored as evidence and only a reference is returned — no image tokens. Set reveal to true only when you must visually inspect the page yourself.",
      inputSchema: {
        browserId: BrowserAutomationBrowserIdSchema,
        fullPage: z.boolean().default(false),
        reveal: z.boolean().default(false),
      },
    },
    async ({ browserId, fullPage, reveal }) => {
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
            reveal: reveal ?? false,
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
        "Set workspace files on a file input in a Paseo browser tab. Use browserId from browser_new_tab or browser_list_tabs; refs come from the latest browser_snapshot of the same tab and expire when the page changes.",
      inputSchema: {
        ref: BrowserRefInputSchema,
        filePaths: z.array(z.string().min(1)).min(1),
        browserId: BrowserAutomationBrowserIdSchema,
      },
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
        "Hover an element in a Paseo browser tab. Use browserId from browser_new_tab or browser_list_tabs; refs come from the latest browser_snapshot of the same tab and expire when the page changes.",
    },
  ] as const) {
    options.registerTool(
      toolConfig.name,
      {
        title: toolConfig.title,
        description: toolConfig.description,
        inputSchema: { ref: BrowserRefInputSchema, browserId: BrowserAutomationBrowserIdSchema },
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
        "Set a select element in a Paseo browser tab to a value. Use browserId from browser_new_tab or browser_list_tabs; refs come from the latest browser_snapshot of the same tab and expire when the page changes.",
      inputSchema: {
        ref: BrowserRefInputSchema,
        value: z.string(),
        browserId: BrowserAutomationBrowserIdSchema,
      },
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
        "Drag one element onto another in a Paseo browser tab. Use browserId from browser_new_tab or browser_list_tabs; refs come from the latest browser_snapshot of the same tab and expire when the page changes.",
      inputSchema: {
        sourceRef: BrowserRefInputSchema,
        targetRef: BrowserRefInputSchema,
        browserId: BrowserAutomationBrowserIdSchema,
      },
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
        "Read recent console messages and browser performance network entries for a Paseo browser tab. Use browserId from browser_new_tab or browser_list_tabs; maxEntries defaults to 50.",
      inputSchema: {
        maxEntries: z.number().int().positive().max(200).optional(),
        browserId: BrowserAutomationBrowserIdSchema,
      },
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

  options.registerTool(
    "browser_evaluate",
    {
      title: "Evaluate browser JavaScript",
      description:
        "Evaluate a JavaScript function in a Paseo browser tab. Use browserId from browser_new_tab or browser_list_tabs; when ref is provided, refs come from the latest browser_snapshot and the resolved element is passed as the first argument.",
      inputSchema: {
        function: z.string().min(1),
        ref: BrowserRefInputSchema.optional(),
        browserId: BrowserAutomationBrowserIdSchema,
      },
    },
    async ({ function: functionSource, ref, browserId }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        command: {
          command: "evaluate",
          args: {
            browserId,
            function: functionSource,
            ...(ref ? { ref } : {}),
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  options.registerTool(
    "browser_scroll",
    {
      title: "Scroll browser",
      description:
        "Scroll a Paseo browser tab by deltaX/deltaY CSS pixels. Use browserId from browser_new_tab or browser_list_tabs; optional ref comes from the latest browser_snapshot and centers the wheel input over that element.",
      inputSchema: {
        browserId: BrowserAutomationBrowserIdSchema,
        ref: BrowserRefInputSchema.optional(),
        deltaX: z.number(),
        deltaY: z.number(),
      },
    },
    async ({ browserId, ref, deltaX, deltaY }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        command: {
          command: "scroll",
          args: {
            browserId,
            ...(ref ? { ref } : {}),
            deltaX,
            deltaY,
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  options.registerTool(
    "browser_resize",
    {
      title: "Resize browser viewport",
      description:
        "Resize a Paseo browser tab's resident webview viewport. Use browserId from browser_new_tab or browser_list_tabs.",
      inputSchema: {
        browserId: BrowserAutomationBrowserIdSchema,
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      },
    },
    async ({ browserId, width, height }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        command: {
          command: "resize",
          args: {
            browserId,
            width,
            height,
          },
        },
      });
      return browserToolResult({ payload, context: { ...context, browserId } });
    },
  );

  options.registerTool(
    "browser_close_tab",
    {
      title: "Close browser tab",
      description:
        "Close a Paseo browser tab, remove its resident webview, and unregister it from the browser automation host. Use browserId from browser_new_tab or browser_list_tabs.",
      inputSchema: {
        browserId: BrowserAutomationBrowserIdSchema,
      },
    },
    async ({ browserId }) => {
      const context = resolveBrowserToolContext(options);
      const payload = await options.broker.execute({
        agentId: context.agentId,
        cwd: context.cwd,
        ...(context.workspaceId ? { workspaceId: context.workspaceId } : {}),

        command: {
          command: "close_tab",
          args: {
            browserId,
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
        ...(payload.dialogs ? { dialogs: payload.dialogs } : {}),
        context,
      },
    };
  }

  return {
    content: [
      {
        type: "text",
        text: appendDialogSummary(summarizeBrowserError(payload.error), payload.dialogs),
      },
    ],
    structuredContent: {
      ok: false,
      error: payload.error,
      ...(payload.dialogs ? { dialogs: payload.dialogs } : {}),
      context,
    },
  };
}

function browserGoalToolResult(
  result: JevBrowserGoalResult,
  context: { agentId?: string; cwd?: string; workspaceId?: string },
): PaseoToolResult {
  const trace = result.steps
    .map((step) => {
      const target = step.target ? ` target=${step.target}` : "";
      const value = step.value ? ` value=${step.value}` : "";
      return `- ${step.step}. ${step.operation}${target}${value} (${step.outcome}, confidence=${step.confidence.toFixed(2)}, ${step.latencyMs}ms)`;
    })
    .join("\n");
  return {
    content: [
      {
        type: "text",
        text: [
          `Browser goal ${result.status}: ${result.message}`,
          `Title: ${result.title || "Untitled"}`,
          `URL: ${result.url}`,
          ...(trace ? ["", trace] : []),
        ].join("\n"),
      },
    ],
    structuredContent: {
      ok: result.status === "passed",
      result,
      context: { ...context, browserId: result.browserId },
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
  if (result.command !== "screenshot" || !result.dataBase64) {
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
  const withDialogs = (summary: string) => appendDialogSummary(summary, payload.dialogs);
  const controlSummary = summarizeBrowserControlSuccess(payload.result);
  if (controlSummary) {
    return withDialogs(controlSummary);
  }

  const refActionSummary = summarizeBrowserRefActionSuccess(payload.result);
  if (refActionSummary) {
    return withDialogs(refActionSummary);
  }

  const diagnosticsSummary = summarizeBrowserDiagnosticsSuccess(payload.result);
  if (diagnosticsSummary) {
    return withDialogs(diagnosticsSummary);
  }

  const keyboardSummary = summarizeBrowserKeyboardSuccess(payload.result);
  if (keyboardSummary) {
    return withDialogs(keyboardSummary);
  }

  const navigationSummary = summarizeBrowserNavigationSuccess(payload.result);
  if (navigationSummary) {
    return withDialogs(navigationSummary);
  }

  const mediaSummary = summarizeBrowserMediaSuccess(payload.result);
  if (mediaSummary) {
    return withDialogs(mediaSummary);
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
    return withDialogs(
      [
        `Found ${count} Paseo browser tab${count === 1 ? "" : "s"}. Use these browserId values for tab-scoped browser tools.`,
        ...tabLines,
      ].join("\n"),
    );
  }

  if (payload.result.command === "new_tab") {
    return withDialogs(
      `Created browser tab browserId=${payload.result.browserId} url=${payload.result.url}. Use this browserId for tab-scoped browser tools. If you are testing, stop and use browser_test with steps instead.`,
    );
  }

  if (payload.result.command === "snapshot") {
    return withDialogs(
      [
        `Snapshot captured ${payload.result.stats.nodeCount} node${payload.result.stats.nodeCount === 1 ? "" : "s"} with ${payload.result.stats.refCount} ref${payload.result.stats.refCount === 1 ? "" : "s"}.`,
        `Title: ${payload.result.title || "Untitled"}`,
        `URL: ${payload.result.url}`,
        "",
        payload.result.snapshot,
      ].join("\n"),
    );
  }

  if (payload.result.command === "wait") {
    return withDialogs(`Browser wait matched ${payload.result.matched}.`);
  }

  return withDialogs(`Browser ${payload.result.command} complete.`);
}

function appendDialogSummary(
  summary: string,
  dialogs: BrowserToolsResponsePayload["dialogs"],
): string {
  if (!dialogs || dialogs.length === 0) {
    return summary;
  }
  return `${summary}\nHandled browser dialog${dialogs.length === 1 ? "" : "s"}: ${dialogs
    .map((dialog) => `${dialog.action} ${dialog.type} ${JSON.stringify(dialog.message)}`)
    .join("; ")}.`;
}

function summarizeBrowserMediaSuccess(
  result: Extract<BrowserToolsResponsePayload, { ok: true }>["result"],
): string | null {
  if (result.command === "screenshot") {
    const base = `Captured browser screenshot (${result.width}x${result.height}).`;
    return result.evidenceRef ? `${base} Evidence: ${result.evidenceRef}` : base;
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
  if (result.command === "evaluate") {
    return [
      "Browser evaluate returned:",
      result.resultJson,
      ...(result.truncated ? ["Result was truncated."] : []),
    ].join("\n");
  }

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
    return result.ref
      ? `Clicked browser element ${result.ref}.`
      : `Clicked browser at (${result.x}, ${result.y}).`;
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
    return result.ref
      ? `Hovered browser element ${result.ref}.`
      : `Hovered browser at (${result.x}, ${result.y}).`;
  }

  if (result.command === "drag") {
    return result.sourceRef && result.targetRef
      ? `Dragged browser element ${result.sourceRef} to ${result.targetRef}.`
      : `Dragged browser from (${result.sourceX}, ${result.sourceY}) to (${result.targetX}, ${result.targetY}).`;
  }

  if (result.command === "scroll") {
    return result.ref
      ? `Scrolled browser element ${result.ref} by ${result.deltaX}, ${result.deltaY}.`
      : `Scrolled browser by ${result.deltaX}, ${result.deltaY}.`;
  }

  if (result.command === "resize") {
    return `Resized browser viewport to ${result.width}x${result.height}.`;
  }

  if (result.command === "close_tab") {
    return `Closed browser tab ${result.browserId}.`;
  }

  return null;
}

function summarizeBrowserError(
  error: Extract<BrowserToolsResponsePayload, { ok: false }>["error"],
): string {
  switch (error.code) {
    case "browser_disabled":
      return "Browser tools are disabled. Enable browser tools on the host, then try again.";
    case "browser_no_host":
      return error.message;
    case "browser_timeout":
      return "The browser did not respond before the timeout. Try again or check the browser host.";
    case "screenshot_no_frame":
      return error.message;
    case "browser_unsupported":
      return error.message;
    case "browser_stale_ref":
      return "That browser element reference is stale. Take a new browser snapshot and try again.";
    default:
      return error.message;
  }
}
