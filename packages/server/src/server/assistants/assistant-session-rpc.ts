import type { AssistantRequest, AssistantResponse } from "@getpaseo/protocol/assistants";
import { AssistantStoreError, type AssistantStore } from "./assistant-store.js";

/**
 * Maps one assistant RPC onto the store for a principal the daemon already
 * trusts. The principal comes from session admission, never from the wire, and
 * every reply is a source-only response so private data never broadcasts.
 */
export class AssistantRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AssistantRequestError";
  }
}

export interface AssistantRpcContext {
  store: AssistantStore | null;
  principalId: string | null;
}

export async function handleAssistantRequest(
  context: AssistantRpcContext,
  request: AssistantRequest,
): Promise<AssistantResponse> {
  const { store, principalId } = context;
  if (!store) {
    throw new AssistantRequestError("unsupported", "This daemon does not support assistants.");
  }
  if (!principalId) {
    throw new AssistantRequestError("unauthorized", "Assistant ownership is unavailable.");
  }
  try {
    return await dispatch(store, principalId, request);
  } catch (error) {
    if (error instanceof AssistantStoreError) {
      throw new AssistantRequestError(error.code, error.message);
    }
    throw error;
  }
}

async function dispatch(
  store: AssistantStore,
  principalId: string,
  request: AssistantRequest,
): Promise<AssistantResponse> {
  const { requestId } = request;
  switch (request.type) {
    case "assistant.list.request":
      return {
        type: "assistant.list.response",
        payload: { requestId, assistants: await store.list(principalId) },
      };
    case "assistant.get.request": {
      const page = await store.get(principalId, request.assistantId, {
        ...(request.beforeSeq !== undefined ? { beforeSeq: request.beforeSeq } : {}),
        ...(request.limit !== undefined ? { limit: request.limit } : {}),
      });
      return { type: "assistant.get.response", payload: { requestId, ...page } };
    }
    case "assistant.create.request": {
      const { type: _type, requestId: _requestId, ...input } = request;
      return {
        type: "assistant.create.response",
        payload: { requestId, assistant: await store.create(principalId, input) },
      };
    }
    case "assistant.update.request": {
      const { type: _type, requestId: _requestId, ...input } = request;
      return {
        type: "assistant.update.response",
        payload: { requestId, assistant: await store.update(principalId, input) },
      };
    }
    case "assistant.delete.request":
      await store.delete(principalId, request.assistantId);
      return { type: "assistant.delete.response", payload: { requestId } };
    case "assistant.compact.request": {
      const { type: _type, requestId: _requestId, ...input } = request;
      return {
        type: "assistant.compact.response",
        payload: { requestId, assistant: await store.compact(principalId, input) },
      };
    }
    case "assistant.template.list.request":
      return {
        type: "assistant.template.list.response",
        payload: { requestId, templates: await store.listTemplates(principalId) },
      };
    case "assistant.template.save.request": {
      const { type: _type, requestId: _requestId, ...input } = request;
      return {
        type: "assistant.template.save.response",
        payload: { requestId, template: await store.saveTemplate(principalId, input) },
      };
    }
    case "assistant.template.delete.request":
      await store.deleteTemplate(principalId, request.templateId);
      return { type: "assistant.template.delete.response", payload: { requestId } };
  }
}
