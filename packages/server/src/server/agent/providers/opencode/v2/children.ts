import { V2Timeline } from "./timeline.js";

import type { SessionInfo } from "@opencode/client";

import type { AgentStreamEvent } from "../../../agent-sdk-types.js";

import type { ProviderSubagentInputEvent } from "../../../provider-subagents/store.js";

import { messages } from "./history.js";
import { buildOpenCodeSubagentSubtitle } from "../subagent-presentation.js";

import type { V2Api } from "./api.js";
interface ChildrenOptions {
  client(): V2Api;
  id: string;
  emit(event: AgentStreamEvent): void;
  reconcilePermissions(id: string): Promise<void>;
  bindChild?: (id: string) => void;
}
interface Child {
  parentID: string;
  timeline: V2Timeline;
  signature?: string;
}
export class SessionChildren {
  private readonly children = new Map<string, Child>();
  constructor(private readonly options: ChildrenOptions) {}
  async observe(event: import("@opencode/client").OpenCodeEvent) {
    if (event.type === "session.deleted") {
      this.remove(event.data.sessionID);
      return;
    }
    if (
      event.type === "session.created" &&
      event.data.parentID &&
      (event.data.parentID === this.options.id || this.children.has(event.data.parentID))
    ) {
      await this.reconcile(event.data.parentID);
    }
    if ("sessionID" in event.data && typeof event.data.sessionID === "string") {
      const child = this.children.get(event.data.sessionID);
      if (child)
        await this.reconcileChild(
          await this.options.client().session.get({ sessionID: event.data.sessionID }),
          child.parentID,
        );
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
    // A complete parent listing is authoritative. Do not prune on a partial or failed page.
    for (const [id] of previous) {
      if (!seen.has(id)) this.remove(id);
    }
  }
  private remove(id: string) {
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
      child = { parentID, timeline: new V2Timeline() };
      this.children.set(info.id, child);
      this.options.bindChild?.(info.id);
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
    await child.timeline.messages(await messages(this.options.client(), info.id), (event) => {
      if (event.type === "timeline")
        this.options.emit({
          type: "provider_subagent",
          provider: "opencode",
          event: { type: "timeline", id: info.id, item: event.item, timestamp: event.timestamp },
        });
    });
  }
}
