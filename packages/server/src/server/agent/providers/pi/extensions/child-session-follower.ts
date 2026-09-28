import type { AgentStreamEvent } from "../../../agent-sdk-types.js";
import type { ProviderSubagentStatus } from "../../../provider-subagents/store.js";
import { CHILD_SESSION_MAX_BYTES_PER_READ, ChildSessionTail } from "./child-session-tail.js";

const DEFAULT_INTERVAL_MS = 1_000;
const SLOW_INTERVAL_MS = 5_000;
const SLOW_AFTER_UNCHANGED_TICKS = 5;
const DEFAULT_MAX_FOLLOWED_FILES = 16;
const DEFAULT_MAX_BYTES_PER_CHILD = 8 * 1024 * 1024;
const TERMINAL_STATUSES = new Set<ProviderSubagentStatus>(["completed", "failed", "canceled"]);

export interface PiChildSessionScheduler {
  schedulePoll(callback: () => void, delayMs: number): () => void;
}

function createScheduler(): PiChildSessionScheduler {
  return {
    schedulePoll: (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      return () => clearTimeout(timer);
    },
  };
}

/** The slice of an extension mapping the follower reads. */
export interface PiChildSessionMapping {
  childSessions?: Array<{ id: string; file: string }>;
  subagents?: Array<{ type: string; id: string; status?: ProviderSubagentStatus }>;
}

export interface PiChildSessionFollowerOptions {
  onEvents(events: AgentStreamEvent[]): void;
  /** Runs before each drain so the caller can refresh adapter state through its poll hooks. */
  onTick(): void;
  /** Whether an extension publishes live child state of its own, which is worth polling for. */
  hasPoll(extensionId: string): boolean;
  onWarn?(message: string, details: Record<string, unknown>): void;
  scheduler?: PiChildSessionScheduler;
  intervalMs?: number;
  maxFollowedFiles?: number;
  maxBytesPerRead?: number;
  maxBytesPerChild?: number;
}

interface FollowedChild {
  extensionId: string;
  status: ProviderSubagentStatus;
}

interface FollowedTail {
  childKey: string;
  file: string;
  tail: ChildSessionTail;
  bytes: number;
  /** The child is finished: read the rest of the file, then stop following it. */
  draining: boolean;
  finished: boolean;
}

function childKey(extensionId: string, childId: string): string {
  return `${extensionId}\0${childId}`;
}

/**
 * Follows Pi child session files while their children are still running.
 *
 * The adapter is the only thing that knows where a transcript lives, but it sees the child through
 * single tool results, so this owns everything after the handoff: which files are still growing,
 * when a child has finished, and how often to look. Reads are offset-based, so re-reading a file
 * that has not grown costs one stat and produces nothing.
 *
 * One read per tick is not enough on its own, because the tick interval is what bounds latency and
 * the byte budget is what bounds work. A running child therefore gets one chunk per tick, and a
 * finished one is read to the end in that same tick so its last rows are never left behind.
 */
export class PiChildSessionFollower {
  private readonly tails = new Map<string, FollowedTail>();
  private readonly children = new Map<string, FollowedChild>();
  private readonly scheduler: PiChildSessionScheduler;
  private cancelScheduled: (() => void) | null = null;
  private closed = false;
  private draining = false;
  private drainRequested = false;
  private unchangedTicks = 0;

  constructor(private readonly options: PiChildSessionFollowerOptions) {
    this.scheduler = options.scheduler ?? createScheduler();
  }

  get active(): boolean {
    return !this.closed && this.shouldPoll();
  }

  /** Records what one adapter mapping said about its children, then reads anything new. */
  accept(extensionId: string, mapping: PiChildSessionMapping): void {
    if (this.closed) return;
    for (const event of mapping.subagents ?? []) {
      if (event.type === "remove") {
        this.dropChild(extensionId, event.id);
        continue;
      }
      // A presentation-only upsert says nothing about whether the child is still running, so it
      // must not be read as either state.
      if (event.status === undefined) continue;
      this.setStatus(extensionId, event.id, event.status);
    }
    for (const { id, file } of mapping.childSessions ?? []) {
      this.follow(extensionId, id, file);
    }
    void this.drainAndEmit();
  }

  close(): void {
    this.closed = true;
    this.cancelScheduled?.();
    this.cancelScheduled = null;
    this.tails.clear();
    this.children.clear();
  }

  private setStatus(extensionId: string, childId: string, status: ProviderSubagentStatus): void {
    const key = childKey(extensionId, childId);
    this.children.set(key, { extensionId, status });
    if (!TERMINAL_STATUSES.has(status)) return;
    for (const tail of this.tails.values()) {
      if (tail.childKey === key) tail.draining = true;
    }
  }

  private dropChild(extensionId: string, childId: string): void {
    const key = childKey(extensionId, childId);
    this.children.delete(key);
    for (const [file, tail] of this.tails) {
      if (tail.childKey === key) this.tails.delete(file);
    }
  }

  private follow(extensionId: string, childId: string, file: string): void {
    if (this.tails.has(file)) return;
    if (this.tails.size >= (this.options.maxFollowedFiles ?? DEFAULT_MAX_FOLLOWED_FILES)) {
      this.warn("Pi child session follow limit reached", { file });
      return;
    }
    const key = childKey(extensionId, childId);
    const status = this.children.get(key)?.status;
    this.tails.set(file, {
      childKey: key,
      file,
      tail: new ChildSessionTail(childId, file),
      bytes: 0,
      // A path that only arrives with the child's outcome still has a whole file to read.
      draining: status !== undefined && TERMINAL_STATUSES.has(status),
      finished: false,
    });
  }

  private shouldPoll(): boolean {
    for (const tail of this.tails.values()) {
      if (!tail.finished) return true;
    }
    for (const child of this.children.values()) {
      if (TERMINAL_STATUSES.has(child.status)) continue;
      if (this.options.hasPoll(child.extensionId)) return true;
    }
    return false;
  }

  private async tick(): Promise<void> {
    this.cancelScheduled = null;
    if (this.closed) return;
    try {
      this.options.onTick();
    } catch (error) {
      this.warn("Pi child session poll failed", { err: error });
    }
    await this.drainAndEmit();
  }

  private async drainAndEmit(): Promise<void> {
    if (this.closed) return;
    if (this.draining) {
      this.drainRequested = true;
      return;
    }
    this.draining = true;
    try {
      do {
        this.drainRequested = false;
        const { events, bytes } = await this.drainAll();
        if (this.closed) return;
        this.unchangedTicks = bytes > 0 ? 0 : this.unchangedTicks + 1;
        if (events.length) this.options.onEvents(events);
      } while (this.drainRequested && !this.closed);
    } finally {
      this.draining = false;
    }
    this.refreshSchedule();
  }

  private async drainAll(): Promise<{ events: AgentStreamEvent[]; bytes: number }> {
    const events: AgentStreamEvent[] = [];
    let total = 0;
    for (const tail of this.tails.values()) {
      if (tail.finished) continue;
      let lastBytes = 0;
      for (;;) {
        const read = await tail.tail.read(
          this.options.maxBytesPerRead ?? CHILD_SESSION_MAX_BYTES_PER_READ,
        );
        lastBytes = read.bytes;
        total += read.bytes;
        tail.bytes += read.bytes;
        for (const event of read.events) {
          events.push({ type: "provider_subagent", provider: "pi", event });
        }
        if (this.closed) return { events, bytes: total };
        if (read.fatal) {
          this.finish(tail, "child session file is no longer readable");
          break;
        }
        if (tail.bytes >= (this.options.maxBytesPerChild ?? DEFAULT_MAX_BYTES_PER_CHILD)) {
          this.finish(tail, "child session follow byte budget exhausted");
          break;
        }
        if (!tail.draining || lastBytes <= 0) break;
      }
      if (tail.draining && !tail.finished && lastBytes <= 0) tail.finished = true;
    }
    return { events, bytes: total };
  }

  private finish(tail: FollowedTail, reason: string): void {
    tail.finished = true;
    this.warn(reason, { file: tail.file });
  }

  private refreshSchedule(): void {
    this.cancelScheduled?.();
    this.cancelScheduled = null;
    if (!this.shouldPoll()) return;
    const delay =
      this.unchangedTicks >= SLOW_AFTER_UNCHANGED_TICKS
        ? SLOW_INTERVAL_MS
        : (this.options.intervalMs ?? DEFAULT_INTERVAL_MS);
    this.cancelScheduled = this.scheduler.schedulePoll(() => {
      void this.tick();
    }, delay);
  }

  private warn(message: string, details: Record<string, unknown>): void {
    this.options.onWarn?.(message, details);
  }
}
