import { TimelineProjection } from "./timeline-projection.js";
import type { AgentStreamEvent } from "./agent-sdk-types.js";

// Replay canonical items, rather than retaining every streamed delta or tool state.
// Sequence numbers here only preserve adapter replay order, not wire cursors.
export class PluginSessionHistory {
  private readonly timelines = new Map<
    string,
    { projection: TimelineProjection; seq: number; positions: Map<number, number> }
  >();
  private readonly events: Array<{ seq: number; event: AgentStreamEvent }> = [];
  private seq = 0;

  push(event: AgentStreamEvent): void {
    const seq = ++this.seq;
    const child =
      event.type === "provider_subagent" && event.event.type === "timeline" ? event.event : null;
    if (event.type !== "timeline" && !child) {
      this.events.push({ seq, event });
      return;
    }
    const key = child?.id ?? "";
    let projection = this.timelines.get(key);
    if (!projection) {
      projection = { projection: new TimelineProjection(), seq: 0, positions: new Map() };
      this.timelines.set(key, projection);
    }
    const timeline = event.type === "timeline" ? event : child!;
    const row = projection.projection.append({
      seq: ++projection.seq,
      item: timeline.item,
      timestamp: timeline.timestamp ?? "",
      ...(event.type === "timeline" && event.turnId ? { turnId: event.turnId } : {}),
    });
    if (!projection.positions.has(row.seqStart)) projection.positions.set(row.seqStart, seq);
  }

  read(provider: string): AgentStreamEvent[] {
    const events = [...this.events];
    for (const [id, projection] of this.timelines) {
      for (const row of projection.projection.getRows()) {
        const timestamp = row.timestamp ? { timestamp: row.timestamp } : {};
        const event: AgentStreamEvent = id
          ? {
              type: "provider_subagent",
              provider,
              event: { type: "timeline", id, item: row.item, ...timestamp },
            }
          : {
              type: "timeline",
              provider,
              item: row.item,
              ...timestamp,
              ...(row.turnId ? { turnId: row.turnId } : {}),
            };
        events.push({ seq: projection.positions.get(row.seqStart)!, event });
      }
    }
    return events.sort((a, b) => a.seq - b.seq).map(({ event }) => event);
  }

  clear(): void {
    this.timelines.clear();
    this.events.length = 0;
  }
}
