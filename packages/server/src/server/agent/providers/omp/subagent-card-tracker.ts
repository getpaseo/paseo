import type { ToolCallDetail } from "../../agent-sdk-types.js";
import type { OmpSubagentLifecyclePayload, OmpSubagentProgressPayload } from "./rpc-types.js";

interface OmpSubagentCardChild {
  index: number;
  description?: string;
  childSessionId?: string;
}

/**
 * Fills a task card's description and child session from OMP's sub-agent events. The card is a
 * launch marker; the child's activity belongs to the sub-agent's own timeline.
 */
export class OmpSubagentCardTracker {
  private readonly children = new Map<string, Map<number, OmpSubagentCardChild>>();

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
    const children = this.children.get(toolCallId);
    const first = children
      ? [...children.values()].sort((left, right) => left.index - right.index)[0]
      : undefined;
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
    this.children.delete(toolCallId);
  }

  clear(): void {
    this.children.clear();
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
    const children = this.children.get(toolCallId) ?? new Map<number, OmpSubagentCardChild>();
    this.children.set(toolCallId, children);
    const existing = children.get(input.index);
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
    children.set(input.index, next);
    emitToolCall(toolCallId);
  }
}

function readTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
