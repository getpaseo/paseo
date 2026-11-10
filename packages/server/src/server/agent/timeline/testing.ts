import { setImmediate as nextTurn } from "node:timers/promises";
import type { AgentTimelineItem } from "../agent-sdk-types.js";
import type {
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineRow,
} from "../agent-timeline-store-types.js";
import type { ProjectedTimelineRow } from "../timeline-projection.js";
import type {
  AgentTimelineBackend,
  TimelineBackendAppendResult,
  TimelineBackendRetireResult,
  TimelineEntry,
  TimelineHead,
  TimelinePrompt,
  TimelineRewindIntent,
  TimelineScope,
  TimelineSeed,
} from "./internal/backend.js";
import { MemoryTimelineBackend } from "./internal/memory-backend.js";

/**
 * Testing entry point of the timeline module. Production code imports `./index.js`.
 *
 * Defers every call by a turn of the event loop, the shape of an I/O-backed store, and records
 * the committed appends and whole-history reads.
 */
export class DeferredTimelineBackend implements AgentTimelineBackend {
  private readonly memory = new MemoryTimelineBackend();
  readonly appends: TimelineEntry[][] = [];
  readRowsCalls = 0;
  failNextAppend = false;
  failNextRetire = false;

  private async defer<T>(call: () => T): Promise<T> {
    await nextTurn();
    return call();
  }

  create(scope: TimelineScope, seed: TimelineSeed): Promise<TimelineHead> {
    return this.defer(() => this.memory.create(scope, seed));
  }
  delete(scope: TimelineScope): Promise<void> {
    return this.defer(() => this.memory.delete(scope));
  }
  head(scope: TimelineScope): Promise<TimelineHead | null> {
    return this.defer(() => this.memory.head(scope));
  }
  append(
    scope: TimelineScope,
    entries: readonly TimelineEntry[],
  ): Promise<TimelineBackendAppendResult> {
    return this.defer(() => {
      if (this.failNextAppend) {
        this.failNextAppend = false;
        throw new Error("disk full");
      }
      const result = this.memory.append(scope, entries);
      this.appends.push([...entries]);
      return result;
    });
  }
  isRetired(scope: TimelineScope, entry: TimelineEntry): Promise<boolean> {
    return this.defer(() => this.memory.isRetired(scope, entry));
  }
  prompts(scope: TimelineScope): Promise<TimelinePrompt[]> {
    return this.defer(() => this.memory.prompts(scope));
  }
  setRewind(scope: TimelineScope, rewind: TimelineRewindIntent | null): Promise<TimelineHead> {
    return this.defer(() => this.memory.setRewind(scope, rewind));
  }
  retire(
    scope: TimelineScope,
    input: { retireFromSeq: number },
  ): Promise<TimelineBackendRetireResult> {
    return this.defer(() => {
      if (this.failNextRetire) {
        this.failNextRetire = false;
        throw new Error("disk full");
      }
      return this.memory.retire(scope, input);
    });
  }
  /** Rows rewinds retired; they stay stored. */
  retiredRows(scope: TimelineScope): ProjectedTimelineRow[] {
    return this.memory.retiredRows(scope);
  }
  attachProviderMessageId(
    scope: TimelineScope,
    clientMessageId: string,
    providerMessageId: string,
  ): Promise<AgentTimelineRow | null> {
    return this.defer(() =>
      this.memory.attachProviderMessageId(scope, clientMessageId, providerMessageId),
    );
  }
  findSubmittedPrompt(
    scope: TimelineScope,
    clientMessageId: string,
  ): Promise<AgentTimelineRow | null> {
    return this.defer(() => this.memory.findSubmittedPrompt(scope, clientMessageId));
  }
  fetch(
    scope: TimelineScope,
    options: AgentTimelineFetchOptions,
  ): Promise<AgentTimelineFetchResult> {
    return this.defer(() => this.memory.fetch(scope, options));
  }
  readRows(scope: TimelineScope): Promise<ProjectedTimelineRow[]> {
    this.readRowsCalls += 1;
    return this.defer(() => this.memory.readRows(scope));
  }
  lastItem(scope: TimelineScope): Promise<AgentTimelineItem | null> {
    return this.defer(() => this.memory.lastItem(scope));
  }
  lastAssistantMessage(scope: TimelineScope): Promise<string | null> {
    return this.defer(() => this.memory.lastAssistantMessage(scope));
  }
}
