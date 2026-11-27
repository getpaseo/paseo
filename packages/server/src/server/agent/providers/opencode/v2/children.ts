import { V2Timeline } from "./timeline.js";

import {
  isSessionNotFoundError,
  type OpenCodeEvent,
  type SessionInfo,
  type SessionMessageInfo,
} from "@opencode/client";

import type { AgentStreamEvent } from "../../../agent-sdk-types.js";

import type { ProviderSubagentInputEvent } from "../../../provider-subagents/store.js";

import { syncTailMessages } from "./history.js";
import { buildOpenCodeSubagentSubtitle } from "../subagent-presentation.js";

import type { V2Api } from "./api.js";

const DEFAULT_DELTA_DEBOUNCE_MS = 50;

interface ChildrenOptions {
  client(): V2Api;
  id: string;
  emit(event: AgentStreamEvent): void;
  reconcilePermissions(id: string): Promise<void>;
  /** Prepares a descendant session for the current connection. */
  adoptChild?: (id: string) => Promise<void>;
  reportError?: (error: unknown) => void;
  deltaDebounceMs?: number;
}
interface Child {
  parentID: string;
  timeline: V2Timeline;
  history: SessionMessageInfo[];
  signature?: string;
}
export class SessionChildren {
  private readonly children = new Map<string, Child>();
  private readonly pendingParents = new Set<string>();
  private readonly pendingChildren = new Set<string>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushDelay: number | null = null;
  private pendingDelay: number | null = null;
  private draining: Promise<void> | null = null;
  private closed = false;
  constructor(private readonly options: ChildrenOptions) {}
  close() {
    this.closed = true;
    this.clearFlushTimer();
    this.pendingDelay = null;
    this.pendingParents.clear();
    this.pendingChildren.clear();
  }
  private clearFlushTimer() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.flushDelay = null;
  }
  async restoreAdoptions() {
    const { adoptChild } = this.options;
    if (!adoptChild) return;
    for (const id of this.children.keys()) {
      try {
        await adoptChild(id);
      } catch (error) {
        if (!isSessionNotFoundError(error)) throw error;
        this.remove(id);
      }
    }
  }
  /**
   * Non-blocking SSE event hook: removes deleted children immediately and coalesces
   * parent/child reconciliations asynchronously so the event stream reader never stalls.
   */
  enqueue(event: OpenCodeEvent) {
    if (this.closed) return;
    if (event.type === "session.deleted") {
      this.remove(event.data.sessionID);
      return;
    }
    let delayMs: number | null = null;
    if (
      event.type === "session.created" &&
      event.data.parentID &&
      (event.data.parentID === this.options.id || this.children.has(event.data.parentID))
    ) {
      this.pendingParents.add(event.data.parentID);
      delayMs = 0;
    }
    if ("sessionID" in event.data && typeof event.data.sessionID === "string") {
      if (this.children.has(event.data.sessionID)) {
        this.pendingChildren.add(event.data.sessionID);
        const eventDelay =
          event.type === "session.text.delta" || event.type === "session.reasoning.delta"
            ? (this.options.deltaDebounceMs ?? DEFAULT_DELTA_DEBOUNCE_MS)
            : 0;
        delayMs = delayMs === null ? eventDelay : Math.min(delayMs, eventDelay);
      }
    }
    if (delayMs === null) return;
    this.pendingDelay = this.pendingDelay === null ? delayMs : Math.min(this.pendingDelay, delayMs);
    if (!this.draining) this.scheduleFlush(this.pendingDelay);
  }
  private scheduleFlush(delayMs: number) {
    if (this.closed) return;
    if (this.flushTimer && this.flushDelay !== null && this.flushDelay <= delayMs) return;
    this.clearFlushTimer();
    this.flushDelay = delayMs;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushDelay = null;
      void this.drainQueued();
    }, delayMs);
    this.flushTimer.unref();
  }
  private drainQueued(): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = this.runDrain().finally(() => {
      this.draining = null;
      if (!this.closed && (this.pendingParents.size > 0 || this.pendingChildren.size > 0)) {
        this.scheduleFlush(this.pendingDelay ?? 0);
      }
    });
    return this.draining;
  }
  private async runDrain() {
    const parents = [...this.pendingParents];
    this.pendingParents.clear();
    const childIDs = [...this.pendingChildren];
    this.pendingChildren.clear();
    this.pendingDelay = null;
    for (const parentID of parents) {
      if (this.closed) return;
      try {
        await this.reconcile(parentID);
      } catch (error) {
        if (!this.closed) this.options.reportError?.(error);
      }
    }
    for (const childID of childIDs) {
      if (this.closed) return;
      const child = this.children.get(childID);
      if (!child) continue;
      try {
        const info = await this.options.client().session.get({ sessionID: childID });
        if (this.closed) return;
        const current = this.children.get(childID);
        if (current) await this.reconcileChild(info, current.parentID);
      } catch (error) {
        if (isSessionNotFoundError(error)) this.remove(childID);
        else if (!this.closed) this.options.reportError?.(error);
      }
    }
  }
  async reconcile(parentID: string) {
    const previous = [...this.children].filter(([, child]) => child.parentID === parentID);
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.options.client().session.list({
        ...(cursor ? { cursor } : { parentID }),
        limit: 100,
      });
      for (const child of page.data) {
        seen.add(child.id);
        await this.reconcileChild(child, parentID);
        await this.reconcile(child.id);
      }
      cursor = page.cursor.next ?? undefined;
    } while (cursor);
    // Updates can move a live child ahead of the cursor. Confirm deletion before pruning.
    for (const [id] of previous) {
      if (seen.has(id)) continue;
      let info: SessionInfo;
      try {
        info = await this.options.client().session.get({ sessionID: id });
      } catch (error) {
        if (isSessionNotFoundError(error)) this.remove(id);
        continue;
      }
      await this.reconcileChild(info, parentID);
      await this.reconcile(id);
    }
  }
  private remove(id: string) {
    this.pendingChildren.delete(id);
    this.pendingParents.delete(id);
    if (this.pendingChildren.size === 0 && this.pendingParents.size === 0) {
      this.pendingDelay = null;
      this.clearFlushTimer();
    }
    if (!this.children.delete(id)) return;
    // OpenCode deletes a session's descendants with it.
    for (const [childID, child] of this.children) {
      if (child.parentID === id) this.remove(childID);
    }
    this.options.emit({
      type: "provider_subagent",
      provider: "opencode",
      event: { type: "remove", id },
    });
  }
  private async reconcileChild(info: SessionInfo, parentID: string) {
    await this.options.reconcilePermissions(info.id);
    let child = this.children.get(info.id);
    if (!child) {
      await this.options.adoptChild?.(info.id);
      child = this.children.get(info.id) ?? { parentID, timeline: new V2Timeline(), history: [] };
      this.children.set(info.id, child);
    }
    const active = await this.options.client().session.active();
    let status: "running" | "failed" | "canceled" | "completed" = "completed";
    if (active[info.id]) status = "running";
    else if (info.outcome === "failed") status = "failed";
    else if (info.outcome === "interrupted") status = "canceled";
    const subtitle = buildOpenCodeSubagentSubtitle({
      agentName: info.agent,
      modelId: info.model?.id,
      variant: info.model?.variant,
      totalTokens:
        info.tokens.input +
        info.tokens.output +
        info.tokens.reasoning +
        info.tokens.cache.read +
        info.tokens.cache.write,
    });
    const presentation: ProviderSubagentInputEvent = {
      type: "upsert",
      id: info.id,
      parentSubagentId: info.parentID === this.options.id ? null : info.parentID,
      title: info.title ?? null,
      ...(subtitle ? { subtitle } : {}),
      status,
      cwd: info.location.directory,
      timestamp: new Date(info.time.updated).toISOString(),
    };
    const signature = JSON.stringify(presentation);
    if (child.signature !== signature) {
      child.signature = signature;
      this.options.emit({ type: "provider_subagent", provider: "opencode", event: presentation });
    }
    const synced = await syncTailMessages(this.options.client(), info.id, child.history);
    child.history = synced.history;
    await child.timeline.messages(
      synced.history,
      (event) => {
        if (event.type === "timeline")
          this.options.emit({
            type: "provider_subagent",
            provider: "opencode",
            event: { type: "timeline", id: info.id, item: event.item, timestamp: event.timestamp },
          });
      },
      undefined,
      { startIndex: synced.startIndex },
    );
  }
}
