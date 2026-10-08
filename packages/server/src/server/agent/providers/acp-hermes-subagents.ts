import { HermesSubagents } from "@getpaseo/plugin/server/acp";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { AgentStreamEvent } from "../agent-sdk-types.js";

type ChildEvent = Extract<AgentStreamEvent, { type: "provider_subagent" }>;

interface HermesAcpSubagentsOptions {
  provider: string;
  cwd: string;
  emit(event: ChildEvent): void;
}

/** Adapts the same validated SDK child sessions to the built-in ACP event surface. */
export class HermesAcpSubagents {
  private readonly reducer: HermesSubagents;
  private readonly history = new Map<string, ChildEvent>();
  private readonly text = new Map<string, string>();

  constructor(private readonly options: HermesAcpSubagentsOptions) {
    this.reducer = new HermesSubagents({
      sessionId: "acp-root",
      cwd: options.cwd,
      emit: (event) => this.accept(event),
    });
  }

  update(update: SessionUpdate): boolean {
    return this.reducer.accept(update);
  }

  private publish(key: string, event: ChildEvent): void {
    this.history.set(key, event);
    this.options.emit(event);
  }

  private accept(event: ProviderEvent): void {
    if (event.type === "session.opened") {
      this.publish(`${event.sessionId}:state`, {
        type: "provider_subagent",
        provider: this.options.provider,
        event: {
          type: "upsert",
          id: event.sessionId,
          parentSubagentId: event.parentSessionId === "acp-root" ? null : event.parentSessionId,
          title: event.title,
          description: event.description,
          status: "running",
          cwd: event.cwd,
        },
      });
    } else if (event.type === "session.turn" && event.state !== "started") {
      const previous = this.history.get(`${event.sessionId}:state`);
      if (previous?.event.type !== "upsert") return;
      this.publish(`${event.sessionId}:state`, {
        ...previous,
        event: { ...previous.event, status: event.state },
      });
    } else if (event.type === "timeline.item") {
      this.acceptTimeline(event);
    }
  }

  private acceptTimeline(event: Extract<ProviderEvent, { type: "timeline.item" }>): void {
    const { item } = event;
    const key = `${event.sessionId}:${item.id}`;
    if (item.type === "notification") {
      this.publish(key, {
        type: "provider_subagent",
        provider: this.options.provider,
        event: {
          type: "timeline",
          id: event.sessionId,
          item: { type: "notification", level: item.level, message: item.message },
        },
      });
    } else if (item.type === "assistant_message") {
      const before = this.text.get(key) ?? "";
      this.text.set(key, item.text);
      const delta = item.text.startsWith(before) ? item.text.slice(before.length) : item.text;
      const messageId = item.text.startsWith(before) ? item.id : `${item.id}:${item.text.length}`;
      const snapshot: ChildEvent = {
        type: "provider_subagent",
        provider: this.options.provider,
        event: {
          type: "timeline",
          id: event.sessionId,
          item: { type: "assistant_message", messageId, text: item.text },
        },
      };
      this.history.set(key, snapshot);
      if (delta)
        this.options.emit({
          ...snapshot,
          event: {
            type: "timeline",
            id: event.sessionId,
            item: { type: "assistant_message", messageId, text: delta },
          },
        });
    }
  }

  replay(): ChildEvent[] {
    return [...this.history.values()];
  }

  finish(status: "failed" | "canceled"): void {
    this.reducer.finish(status);
  }
}
