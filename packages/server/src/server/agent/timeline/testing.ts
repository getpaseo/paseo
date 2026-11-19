import { setImmediate as nextTurn } from "node:timers/promises";
import type { AgentTimelineItem } from "../agent-sdk-types.js";
import type {
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineRow,
} from "../agent-timeline-store-types.js";
import type { ProjectedTimelineRow } from "../timeline-projection.js";
import type { ProviderSubagentDescriptor } from "../provider-subagents/store.js";
import type {
  AgentTimelineBackend,
  MaybePromise,
  RetiredChildSelector,
  TimelineBackendAppendResult,
  TimelineBackendRetireResult,
  TimelineChild,
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
 */

/** A backend tests can also ask for the rows rewinds retired, which stay stored. */
export interface InspectableTimelineBackend extends AgentTimelineBackend {
  retiredRows(scope: TimelineScope): ProjectedTimelineRow[];
}

/**
 * The backends the timeline contract suite (`agent-timeline.test.ts`) runs against. Every
 * production backend is listed here.
 */
export const TIMELINE_CONTRACT_BACKENDS: ReadonlyArray<{
  name: string;
  create: () => InspectableTimelineBackend;
}> = [{ name: "memory", create: () => new MemoryTimelineBackend() }];

/**
 * Wraps a backend: defers every call by a turn of the event loop, the shape of an I/O-backed
 * store, records the committed appends and whole-history reads, and fails the next append or
 * retirement on request.
 */
export class DeferredTimelineBackend implements AgentTimelineBackend {
  readonly appends: TimelineEntry[][] = [];
  readRowsCalls = 0;
  failNextAppend = false;
  failNextRetire = false;

  constructor(private readonly inner: InspectableTimelineBackend = new MemoryTimelineBackend()) {}

  private async defer<T>(call: () => MaybePromise<T>): Promise<T> {
    await nextTurn();
    return await call();
  }

  create(scope: TimelineScope, seed: TimelineSeed): Promise<TimelineHead> {
    return this.defer(() => this.inner.create(scope, seed));
  }
  delete(scope: TimelineScope): Promise<void> {
    return this.defer(() => this.inner.delete(scope));
  }
  head(scope: TimelineScope): Promise<TimelineHead | null> {
    return this.defer(() => this.inner.head(scope));
  }
  append(
    scope: TimelineScope,
    entries: readonly TimelineEntry[],
  ): Promise<TimelineBackendAppendResult> {
    return this.defer(async () => {
      if (this.failNextAppend) {
        this.failNextAppend = false;
        throw new Error("disk full");
      }
      const result = await this.inner.append(scope, entries);
      this.appends.push([...entries]);
      return result;
    });
  }
  isRetired(scope: TimelineScope, entry: TimelineEntry): Promise<boolean> {
    return this.defer(() => this.inner.isRetired(scope, entry));
  }
  prompts(scope: TimelineScope): Promise<TimelinePrompt[]> {
    return this.defer(() => this.inner.prompts(scope));
  }
  setRewind(scope: TimelineScope, rewind: TimelineRewindIntent | null): Promise<TimelineHead> {
    return this.defer(() => this.inner.setRewind(scope, rewind));
  }
  children(agentId: string): Promise<TimelineChild[]> {
    return this.defer(() => this.inner.children(agentId));
  }
  child(scope: TimelineScope): Promise<TimelineChild | null> {
    return this.defer(() => this.inner.child(scope));
  }
  setChild(scope: TimelineScope, descriptor: ProviderSubagentDescriptor): Promise<void> {
    return this.defer(() => this.inner.setChild(scope, descriptor));
  }
  retire(
    scope: TimelineScope,
    input: { retireFromSeq: number; selectChildren: RetiredChildSelector },
  ): Promise<TimelineBackendRetireResult> {
    return this.defer(() => {
      if (this.failNextRetire) {
        this.failNextRetire = false;
        throw new Error("disk full");
      }
      return this.inner.retire(scope, input);
    });
  }
  /** Rows rewinds retired; they stay stored. */
  retiredRows(scope: TimelineScope): ProjectedTimelineRow[] {
    return this.inner.retiredRows(scope);
  }
  attachProviderMessageId(
    scope: TimelineScope,
    clientMessageId: string,
    providerMessageId: string,
  ): Promise<AgentTimelineRow | null> {
    return this.defer(() =>
      this.inner.attachProviderMessageId(scope, clientMessageId, providerMessageId),
    );
  }
  findSubmittedPrompt(
    scope: TimelineScope,
    clientMessageId: string,
  ): Promise<AgentTimelineRow | null> {
    return this.defer(() => this.inner.findSubmittedPrompt(scope, clientMessageId));
  }
  fetch(
    scope: TimelineScope,
    options: AgentTimelineFetchOptions,
  ): Promise<AgentTimelineFetchResult> {
    return this.defer(() => this.inner.fetch(scope, options));
  }
  readRows(scope: TimelineScope): Promise<ProjectedTimelineRow[]> {
    this.readRowsCalls += 1;
    return this.defer(() => this.inner.readRows(scope));
  }
  lastItem(scope: TimelineScope): Promise<AgentTimelineItem | null> {
    return this.defer(() => this.inner.lastItem(scope));
  }
  lastAssistantMessage(scope: TimelineScope): Promise<string | null> {
    return this.defer(() => this.inner.lastAssistantMessage(scope));
  }
}
