import { V2Timeline } from "./timeline.js";

import type { SessionInfo } from "@opencode/client";

import type { AgentStreamEvent } from "../../../agent-sdk-types.js";

import type { ProviderSubagentInputEvent } from "../../../provider-subagents/store.js";

import { messages } from "./history.js";

import type { V2Api } from "./api.js";

async function visitSessionChildren(
  client: V2Api,
  parentID: string,
  visit: (info: SessionInfo) => Promise<void>,
  visited = new Set([parentID]),
): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await client.session.list({ ...(cursor ? { cursor } : { parentID }), limit: 100 });
    for (const child of page.data) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      await visit(child);
      await visitSessionChildren(client, child.id, visit, visited);
    }
    cursor = page.cursor.next ?? undefined;
  } while (cursor);
}

function childPresentation(
  info: SessionInfo,
  rootID: string,
  active: Awaited<ReturnType<V2Api["session"]["active"]>>,
): ProviderSubagentInputEvent {
  let status: "running" | "failed" | "canceled" | "completed" = "completed";
  if (active[info.id]) status = "running";
  else if (info.outcome === "failed") status = "failed";
  else if (info.outcome === "interrupted") status = "canceled";
  return {
    type: "upsert",
    id: info.id,
    parentSubagentId: info.parentID === rootID ? null : info.parentID,
    title: info.title ?? null,
    status,
    cwd: info.location.directory,
    timestamp: new Date(info.time.updated).toISOString(),
  };
}

function childTimeline(id: string, events: AgentStreamEvent[]): AgentStreamEvent[] {
  return events.flatMap((event): AgentStreamEvent[] =>
    event.type === "timeline"
      ? [
          {
            type: "provider_subagent",
            provider: "opencode",
            event: { type: "timeline", id, item: event.item, timestamp: event.timestamp },
          },
        ]
      : [],
  );
}

export async function readSessionChildrenHistory(
  client: V2Api,
  rootID: string,
): Promise<AgentStreamEvent[]> {
  const children: SessionInfo[] = [];
  await visitSessionChildren(client, rootID, async (info) => {
    children.push(info);
  });
  if (children.length === 0) return [];
  const active = await client.session.active();
  const events: AgentStreamEvent[] = [];
  for (const info of children) {
    events.push({
      type: "provider_subagent",
      provider: "opencode",
      event: childPresentation(info, rootID, active),
    });
    events.push(
      ...childTimeline(info.id, new V2Timeline(false).messages(await messages(client, info.id))),
    );
  }
  return events;
}

interface ChildrenOptions {
  client(): V2Api;
  id: string;
  emit(event: AgentStreamEvent): void;
  reconcilePermissions(id: string): Promise<void>;
  bindChild?: (id: string) => void;
}
export class SessionChildren {
  private readonly children = new Map<string, V2Timeline>();
  private readonly childStates = new Map<string, string>();
  constructor(private readonly options: ChildrenOptions) {}
  async observe(event: import("@opencode/client").OpenCodeEvent) {
    if (
      event.type === "session.created" &&
      event.data.parentID &&
      (event.data.parentID === this.options.id || this.children.has(event.data.parentID))
    ) {
      await this.reconcile(event.data.parentID);
    }
    if (
      "sessionID" in event.data &&
      typeof event.data.sessionID === "string" &&
      this.children.has(event.data.sessionID)
    ) {
      await this.reconcileChild(
        await this.options.client().session.get({ sessionID: event.data.sessionID }),
      );
    }
  }
  async reconcile(parentID: string) {
    await visitSessionChildren(this.options.client(), parentID, (info) =>
      this.reconcileChild(info),
    );
  }
  private async reconcileChild(info: SessionInfo) {
    await this.options.reconcilePermissions(info.id);
    let timeline = this.children.get(info.id);
    if (!timeline) {
      timeline = new V2Timeline();
      this.children.set(info.id, timeline);
      this.options.bindChild?.(info.id);
    }
    const active = await this.options.client().session.active();
    const presentation = childPresentation(info, this.options.id, active);
    const signature = JSON.stringify(presentation);
    if (this.childStates.get(info.id) !== signature) {
      this.childStates.set(info.id, signature);
      this.options.emit({ type: "provider_subagent", provider: "opencode", event: presentation });
    }
    for (const event of childTimeline(
      info.id,
      timeline.messages(await messages(this.options.client(), info.id)),
    ))
      this.options.emit(event);
  }
}
