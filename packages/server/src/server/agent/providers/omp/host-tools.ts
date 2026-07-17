import type { Logger } from "pino";

import {
  addModelVisibleStructuredContent,
  serializePaseoToolInputParameters,
} from "../../tools/paseo-tool-serialization.js";
import type { PaseoToolCatalog, PaseoToolResult } from "../../tools/types.js";
import type { OmpRuntimeSession } from "./runtime.js";
import {
  OmpRpcHostToolCallRequestSchema,
  OmpRpcHostToolCancelRequestSchema,
  OmpRpcHostToolUpdateSchema,
  type OmpAgentToolResult,
  type OmpRpcHostToolCallRequest,
  type OmpRpcHostToolDefinition,
  type OmpRpcHostToolResult,
  type OmpRpcHostToolUpdate,
} from "./rpc-types.js";

interface PendingOmpHostToolCall {
  controller: AbortController;
  canceled: boolean;
}

interface OmpHostToolRouterInput {
  runtimeSession: OmpRuntimeSession;
  catalog: PaseoToolCatalog;
  logger: Logger;
}

const routersByRuntimeSession = new WeakMap<OmpRuntimeSession, OmpHostToolRouter>();

export function serializeOmpHostTools(catalog: PaseoToolCatalog): OmpRpcHostToolDefinition[] {
  return [...catalog.tools.values()].map((tool) => {
    const definition: OmpRpcHostToolDefinition = {
      name: tool.name,
      description: tool.description,
      parameters: serializePaseoToolInputParameters(tool),
    };
    if (tool.title) {
      definition.label = tool.title;
    }
    return definition;
  });
}

export async function setOmpHostTools(
  runtimeSession: OmpRuntimeSession,
  catalog: PaseoToolCatalog,
): Promise<string[]> {
  return await runtimeSession.setHostTools(serializeOmpHostTools(catalog));
}

export function handleOmpHostToolRuntimeEvent(
  event: unknown,
  input: {
    runtimeSession: OmpRuntimeSession;
    paseoTools?: PaseoToolCatalog;
    logger: Logger;
  },
): boolean {
  if (!isRecord(event) || typeof event.type !== "string" || !isOmpHostToolEventType(event.type)) {
    return false;
  }

  const call = OmpRpcHostToolCallRequestSchema.safeParse(event);
  if (call.success) {
    const router = getRouter(input);
    if (!router) {
      sendMissingCatalogResult(input.runtimeSession, call.data);
      return true;
    }
    router.handleCall(call.data);
    return true;
  }

  const cancel = OmpRpcHostToolCancelRequestSchema.safeParse(event);
  if (cancel.success) {
    getRouter(input)?.handleCancel(cancel.data.targetId);
    return true;
  }

  const update = OmpRpcHostToolUpdateSchema.safeParse(event);
  if (update.success) {
    input.logger.debug({ id: update.data.id }, "Ignoring unexpected inbound OMP host tool update");
    return true;
  }

  input.logger.debug({ event }, "Dropped malformed OMP host tool frame");
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function clearOmpHostToolState(runtimeSession: OmpRuntimeSession): void {
  routersByRuntimeSession.get(runtimeSession)?.clear();
  routersByRuntimeSession.delete(runtimeSession);
}

export async function waitForOmpHostToolsIdle(runtimeSession: OmpRuntimeSession): Promise<void> {
  await routersByRuntimeSession.get(runtimeSession)?.waitForIdle();
}

function getRouter(input: {
  runtimeSession: OmpRuntimeSession;
  paseoTools?: PaseoToolCatalog;
  logger: Logger;
}): OmpHostToolRouter | null {
  if (!input.paseoTools) {
    return null;
  }
  const existing = routersByRuntimeSession.get(input.runtimeSession);
  if (existing) {
    return existing;
  }
  const router = new OmpHostToolRouter({
    runtimeSession: input.runtimeSession,
    catalog: input.paseoTools,
    logger: input.logger,
  });
  routersByRuntimeSession.set(input.runtimeSession, router);
  return router;
}

function sendMissingCatalogResult(
  runtimeSession: OmpRuntimeSession,
  request: OmpRpcHostToolCallRequest,
): void {
  runtimeSession.sendHostToolResult(
    toOmpHostToolErrorResult(
      request.id,
      `Host tool "${request.toolName}" was called before Paseo tools were registered`,
    ),
  );
}

function isOmpHostToolEventType(type: string): boolean {
  return type === "host_tool_call" || type === "host_tool_cancel" || type === "host_tool_update";
}

class OmpHostToolRouter {
  private readonly runtimeSession: OmpRuntimeSession;
  private readonly catalog: PaseoToolCatalog;
  private readonly logger: Logger;
  private readonly pendingCalls = new Map<string, PendingOmpHostToolCall>();
  private readonly idleWaiters = new Set<() => void>();

  constructor(input: OmpHostToolRouterInput) {
    this.runtimeSession = input.runtimeSession;
    this.catalog = input.catalog;
    this.logger = input.logger;
  }

  handleCall(request: OmpRpcHostToolCallRequest): void {
    const entry: PendingOmpHostToolCall = {
      controller: new AbortController(),
      canceled: false,
    };
    this.pendingCalls.set(request.id, entry);
    void this.executeCall(request, entry).catch((error: unknown) => {
      this.logger.warn({ err: error, toolName: request.toolName }, "OMP host tool call failed");
    });
  }

  handleCancel(targetId: string): void {
    const pending = this.pendingCalls.get(targetId);
    if (!pending) {
      return;
    }
    pending.canceled = true;
    pending.controller.abort(new Error(`OMP host tool call ${targetId} cancelled`));
  }

  clear(): void {
    for (const pending of this.pendingCalls.values()) {
      pending.canceled = true;
      pending.controller.abort(new Error("OMP session closed"));
    }
    this.pendingCalls.clear();
    this.resolveIdleWaiters();
  }

  waitForIdle(): Promise<void> {
    if (this.pendingCalls.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  private async executeCall(
    request: OmpRpcHostToolCallRequest,
    entry: PendingOmpHostToolCall,
  ): Promise<void> {
    try {
      const result = await this.catalog.executeTool(request.toolName, request.arguments, {
        signal: entry.controller.signal,
        sendUpdate: (update) => {
          if (entry.canceled || entry.controller.signal.aborted) {
            return;
          }
          this.sendUpdate(request.id, update);
        },
      });
      if (entry.canceled || entry.controller.signal.aborted) {
        return;
      }
      this.runtimeSession.sendHostToolResult(toOmpHostToolResult(request.id, result));
    } catch (error) {
      if (entry.canceled || entry.controller.signal.aborted) {
        return;
      }
      this.runtimeSession.sendHostToolResult(toOmpHostToolErrorResult(request.id, error));
    } finally {
      this.pendingCalls.delete(request.id);
      this.resolveIdleWaiters();
    }
  }

  private resolveIdleWaiters(): void {
    if (this.pendingCalls.size > 0) return;
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }

  private sendUpdate(callId: string, result: PaseoToolResult): void {
    const update: OmpRpcHostToolUpdate = {
      type: "host_tool_update",
      id: callId,
      partialResult: toOmpAgentToolResult(addModelVisibleStructuredContent(result)),
    };
    this.runtimeSession.sendHostToolUpdate(update);
  }
}

function toOmpHostToolResult(id: string, result: PaseoToolResult): OmpRpcHostToolResult {
  const modelVisibleResult = addModelVisibleStructuredContent(result);
  const mappedResult = toOmpAgentToolResult(modelVisibleResult);
  return {
    type: "host_tool_result",
    id,
    result: mappedResult,
    ...(modelVisibleResult.isError !== undefined ? { isError: modelVisibleResult.isError } : {}),
  };
}

function toOmpHostToolErrorResult(id: string, error: unknown): OmpRpcHostToolResult {
  return {
    type: "host_tool_result",
    id,
    result: {
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
      details: {},
      isError: true,
    },
    isError: true,
  };
}

function toOmpAgentToolResult(result: PaseoToolResult): OmpAgentToolResult {
  const mapped: OmpAgentToolResult = {
    content: result.content.map((item) => ({ ...item })),
  };
  if (result.structuredContent !== undefined) {
    mapped.details = result.structuredContent;
  }
  if (result.isError !== undefined) {
    mapped.isError = result.isError;
  }
  return mapped;
}
