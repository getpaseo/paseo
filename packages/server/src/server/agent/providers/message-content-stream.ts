export interface AssistantMessageContentEvent {
  type: string;
  contentIndex?: number;
  delta?: string;
}

export interface AssistantMessageContentChunk {
  type: "text" | "thinking";
  text: string;
}

interface PendingContentBlock {
  chunks: AssistantMessageContentChunk[];
  complete: boolean;
}

// Pi and OMP identify every streamed content block with `contentIndex` and may emit deltas for
// an earlier index after a later block has already started. Paseo's timeline is append-only, so
// later blocks wait behind active earlier text/thinking blocks until those earlier blocks end
// (or the message/turn finishes). Non-streamed entries and tool-call blocks are not tracked as
// blockers so they never stall later text.
export class MessageContentStream {
  private readonly blocks = new Map<number, PendingContentBlock>();
  private readonly completedIndexes = new Set<number>();

  update(event: AssistantMessageContentEvent): AssistantMessageContentChunk[] {
    const contentIndex = readContentIndex(event);

    if (event.type === "text_delta" || event.type === "thinking_delta") {
      const chunk: AssistantMessageContentChunk = {
        type: event.type === "text_delta" ? "text" : "thinking",
        text: event.delta ?? "",
      };
      if (contentIndex === null || this.completedIndexes.has(contentIndex)) {
        return [chunk];
      }
      this.ensureBlock(contentIndex).chunks.push(chunk);
      return this.flushReadyBlocks();
    }

    if (contentIndex === null) {
      return [];
    }
    if (event.type === "text_start" || event.type === "thinking_start") {
      if (!this.completedIndexes.has(contentIndex)) {
        this.ensureBlock(contentIndex);
      }
      return this.flushReadyBlocks();
    }
    if (event.type === "text_end" || event.type === "thinking_end") {
      const existing = this.blocks.get(contentIndex);
      if (existing) {
        existing.complete = true;
      } else {
        this.completedIndexes.add(contentIndex);
      }
      return this.flushReadyBlocks();
    }
    return [];
  }

  finish(): AssistantMessageContentChunk[] {
    for (const block of this.blocks.values()) {
      block.complete = true;
    }
    const chunks = this.flushReadyBlocks();
    this.reset();
    return chunks;
  }

  reset(): void {
    this.blocks.clear();
    this.completedIndexes.clear();
  }

  private ensureBlock(contentIndex: number): PendingContentBlock {
    const existing = this.blocks.get(contentIndex);
    if (existing) {
      return existing;
    }
    const block: PendingContentBlock = { chunks: [], complete: false };
    this.blocks.set(contentIndex, block);
    return block;
  }

  private flushReadyBlocks(): AssistantMessageContentChunk[] {
    const chunks: AssistantMessageContentChunk[] = [];
    while (this.blocks.size > 0) {
      const contentIndex = Math.min(...this.blocks.keys());
      const block = this.blocks.get(contentIndex);
      if (!block) break;
      chunks.push(...block.chunks.splice(0));
      if (!block.complete) break;
      this.blocks.delete(contentIndex);
      this.completedIndexes.add(contentIndex);
    }
    return chunks;
  }
}

function readContentIndex(event: AssistantMessageContentEvent): number | null {
  return typeof event.contentIndex === "number" &&
    Number.isInteger(event.contentIndex) &&
    event.contentIndex >= 0
    ? event.contentIndex
    : null;
}
