import { SentenceChunker } from "./chunker.js";
import { SLOW_MODELS, type Brain, type ConversationEvent, type ModelFlag } from "./types.js";

export const DEFAULT_FILLER = "One sec.";

// Questions about harness or agent state almost always need a tool. A false positive costs a
// harmless acknowledgement; a miss falls back to the filler at the first tool_use.
const TOOL_HINT =
  /\b(harness|status|tickets?|linear|decisions?|handoff|plan|files?|read|search|mentions?|lab|inbox|dispatch|heading|title|readme|agents?|running|open|check|look up|find)\b/i;

export function looksLikeToolTurn(text: string): boolean {
  return TOOL_HINT.test(text);
}

/** Tool-looking questions always; on sonnet or opus every non-trivial turn (four or more words). */
export function wantsFiller(text: string, model: ModelFlag): boolean {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return looksLikeToolTurn(text) || (SLOW_MODELS.includes(model) && words >= 4);
}

export interface ConversationAgentOptions {
  brain: Brain;
  model: ModelFlag;
  onEvent: (event: ConversationEvent) => void;
  /** Spoken when a turn will be slow. Null turns it off. */
  filler?: string | null;
  /** How long an interrupted turn may take to settle before it is abandoned. */
  interruptTimeoutMs?: number;
}

/**
 * One voice conversation: transcripts in, chunked reply text out. A new transcript while a turn
 * runs is a barge-in. A generation counter makes the old turn's late output inert.
 */
export class ConversationAgent {
  private generation = 0;
  private active: Promise<void> | null = null;
  private latestTicket = 0;
  private closed = false;
  private interrupting: { turn: Promise<void>; done: Promise<unknown> } | null = null;
  private abandonTurn: (() => void) | null = null;
  private readonly filler: string | null;

  constructor(private readonly options: ConversationAgentOptions) {
    this.filler = options.filler === undefined ? DEFAULT_FILLER : options.filler;
  }

  get busy(): boolean {
    return this.active !== null;
  }

  /**
   * Run one turn to its end. Resolves when the turn finishes or is interrupted. Turns never
   * overlap: when several transcripts arrive during one turn, only the newest runs.
   */
  async handleTranscript(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    const ticket = ++this.latestTicket;
    if (this.closed) return;
    while (this.active) await this.bargeIn();
    if (this.closed || ticket !== this.latestTicket) return;
    const turn = this.runTurn(++this.generation, trimmed);
    this.active = turn;
    try {
      await turn;
    } finally {
      if (this.active === turn) this.active = null;
    }
  }

  /** Stop the current turn now. Safe to call when idle. */
  async bargeIn(): Promise<void> {
    const running = this.active;
    if (!running) return;
    // Concurrent callers share one interruption of the same turn.
    if (!this.interrupting || this.interrupting.turn !== running) {
      const turnId = this.generation;
      this.generation += 1;
      this.options.onEvent({ type: "interrupted", turnId });
      this.interrupting = {
        turn: running,
        done: this.settle(running),
      };
    }
    await this.interrupting.done;
  }

  /** Interrupt the brain, then wait for the turn; abandon it if it never settles. */
  private async settle(running: Promise<void>): Promise<void> {
    const limit = this.options.interruptTimeoutMs ?? 3000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        this.abandonTurn?.();
        resolve();
      }, limit);
    });
    try {
      // A rejected interrupt must not block the replacement turn: keep waiting, then abandon.
      const interrupted = this.options.brain.interrupt().catch(() => {});
      await Promise.race([interrupted.then(() => running), timeout]);
    } finally {
      clearTimeout(timer);
    }
    // An abandoned turn settles as soon as its pending read is dropped.
    await running;
  }

  async close(): Promise<void> {
    // Mark closed first so queued transcripts woken by the interrupt do not start a new turn.
    this.closed = true;
    await this.bargeIn();
    await this.options.brain.close();
  }

  private async runTurn(turnId: number, text: string): Promise<void> {
    const { brain, model, onEvent } = this.options;
    const current = () => this.generation === turnId;
    const chunker = new SentenceChunker();
    let fillerSpoken = false;
    let spoke = false;

    const sayFiller = () => {
      if (fillerSpoken || spoke || !this.filler || !current()) return;
      fillerSpoken = true;
      onEvent({ type: "speak", turnId, text: this.filler, kind: "filler" });
    };
    const emitChunks = (chunks: string[]) => {
      if (!current()) return;
      for (const chunk of chunks) {
        spoke = true;
        onEvent({ type: "assistant_chunk", turnId, text: chunk });
        onEvent({ type: "speak", turnId, text: chunk, kind: "reply" });
      }
    };

    if (wantsFiller(text, model)) sayFiller();
    const abandoned = new Promise<{ done: true; value: undefined }>((resolve) => {
      this.abandonTurn = () => resolve({ done: true, value: undefined });
    });
    const iterator = brain.runTurn(text)[Symbol.asyncIterator]();
    try {
      for (;;) {
        // Race each read against abandonment: a brain that never answers must not hold the turn.
        const next = await Promise.race([iterator.next(), abandoned]);
        if (next.done || !current()) break;
        const event = next.value;
        if (event.type === "text") emitChunks(chunker.feed(event.text));
        else if (event.type === "tool_use") sayFiller();
        else emitChunks(chunker.flush());
      }
      void iterator.return?.(undefined)?.catch(() => {});
      if (!current()) return;
      emitChunks(chunker.flush());
      if (current()) onEvent({ type: "turn_end", turnId });
    } catch (error) {
      if (current()) {
        onEvent({
          type: "error",
          turnId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
