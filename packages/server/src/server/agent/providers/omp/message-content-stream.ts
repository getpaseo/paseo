import type {
  OmpAssistantContent,
  OmpAssistantMessageEvent,
  OmpAgentMessage,
} from "./rpc-types.js";

export interface OmpMessageContentChunk {
  type: "text" | "thinking";
  text: string;
}

interface PendingContentBlock {
  chunks: OmpMessageContentChunk[];
  complete: boolean;
}

// OMP may revisit an earlier contentIndex while a later block is already streaming. Paseo's
// timeline is append-only, so later blocks wait here until every earlier block has ended.
export class OmpMessageContentStream {
  private readonly blocks = new Map<number, PendingContentBlock>();
  private readonly completedIndexes = new Set<number>();

  start(content: OmpAssistantContent[]): void {
    this.reset();
    this.seedBlocks(content);
  }

  update(
    event: OmpAssistantMessageEvent,
    message?: Extract<OmpAgentMessage, { role: "assistant" }>,
  ): OmpMessageContentChunk[] {
    this.seedBlocks(message?.content ?? []);
    const contentIndex = readContentIndex(event);

    if (event.type === "text_delta" || event.type === "thinking_delta") {
      const chunk = {
        type: event.type === "text_delta" ? ("text" as const) : ("thinking" as const),
        text: event.delta ?? "",
      };
      if (contentIndex === null) {
        return [chunk];
      }
      this.ensureBlock(contentIndex).chunks.push(chunk);
      return this.flushReadyBlocks();
    }

    if (contentIndex === null) {
      return [];
    }
    if (isContentStart(event)) {
      this.ensureBlock(contentIndex);
      return this.flushReadyBlocks();
    }
    if (isContentEnd(event)) {
      this.ensureBlock(contentIndex).complete = true;
      return this.flushReadyBlocks();
    }
    return [];
  }

  finish(): OmpMessageContentChunk[] {
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

  private seedBlocks(content: OmpAssistantContent[]): void {
    for (let index = 0; index < content.length; index += 1) {
      this.ensureBlock(index);
    }
  }

  private ensureBlock(contentIndex: number): PendingContentBlock {
    const existing = this.blocks.get(contentIndex);
    if (existing) {
      return existing;
    }
    const block = { chunks: [], complete: false };
    if (!this.completedIndexes.has(contentIndex)) {
      this.blocks.set(contentIndex, block);
    }
    return block;
  }

  private flushReadyBlocks(): OmpMessageContentChunk[] {
    const chunks: OmpMessageContentChunk[] = [];
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

// A missing or negative index means the runtime did not identify the block; callers then
// stream the chunk directly instead of holding it behind earlier blocks.
function readContentIndex(event: OmpAssistantMessageEvent): number | null {
  const { contentIndex } = event;
  return contentIndex !== undefined && Number.isInteger(contentIndex) && contentIndex >= 0
    ? contentIndex
    : null;
}

function isContentStart(event: OmpAssistantMessageEvent): boolean {
  return (
    event.type === "text_start" ||
    event.type === "thinking_start" ||
    event.type === "toolcall_start"
  );
}

function isContentEnd(event: OmpAssistantMessageEvent): boolean {
  return (
    event.type === "text_end" || event.type === "thinking_end" || event.type === "toolcall_end"
  );
}
