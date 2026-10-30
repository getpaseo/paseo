import type { ToolCallDetail } from "../../agent-sdk-types.js";
import type { OmpSubagentLifecyclePayload, OmpSubagentProgressPayload } from "./rpc-types.js";

interface OmpSubagentCardChild {
  index: number;
  description?: string;
  childSessionId?: string;
}

/**
 * Fills a task card's description and child session from OMP's sub-agent events. The card is a
 * launch marker that names the task's first child; the children's activity belongs to their own
 * timelines.
 */
export class OmpSubagentCardTracker {
  private readonly firstChildren = new Map<string, OmpSubagentCardChild>();

  handleLifecycle(
    payload: OmpSubagentLifecyclePayload,
    emitToolCall: (toolCallId: string) => boolean,
  ): void {
    this.update(
      payload.parentToolCallId,
      {
        index: payload.index,
        description: payload.description,
        childSessionId: payload.sessionFile,
      },
      emitToolCall,
    );
  }

  handleProgress(
    payload: OmpSubagentProgressPayload,
    emitToolCall: (toolCallId: string) => boolean,
  ): void {
    this.update(
      payload.parentToolCallId,
      {
        index: payload.index,
        description: payload.progress.description,
        childSessionId: payload.sessionFile,
      },
      emitToolCall,
    );
  }

  detailFor(toolCallId: string, baseDetail: ToolCallDetail): ToolCallDetail {
    if (baseDetail.type !== "sub_agent") {
      return baseDetail;
    }
    const first = this.firstChildren.get(toolCallId);
    if (!first) {
      return baseDetail;
    }
    const description = baseDetail.description ?? first.description;
    const childSessionId = first.childSessionId ?? baseDetail.childSessionId;
    return {
      ...baseDetail,
      ...(description ? { description } : {}),
      ...(childSessionId ? { childSessionId } : {}),
    };
  }

  delete(toolCallId: string): void {
    this.firstChildren.delete(toolCallId);
  }

  clear(): void {
    this.firstChildren.clear();
  }

  private update(
    parentToolCallId: string | undefined,
    input: { index: number; description?: string; childSessionId?: string },
    emitToolCall: (toolCallId: string) => boolean,
  ): void {
    const toolCallId = readTrimmedString(parentToolCallId);
    if (!toolCallId) {
      return;
    }
    const first = this.firstChildren.get(toolCallId);
    if (first && input.index > first.index) {
      return;
    }
    const existing = first?.index === input.index ? first : undefined;
    const next: OmpSubagentCardChild = {
      index: input.index,
      description: readTrimmedString(input.description) ?? existing?.description,
      childSessionId: readTrimmedString(input.childSessionId) ?? existing?.childSessionId,
    };
    if (
      existing &&
      existing.description === next.description &&
      existing.childSessionId === next.childSessionId
    ) {
      return;
    }
    this.firstChildren.set(toolCallId, next);
    emitToolCall(toolCallId);
  }
}

function readTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
