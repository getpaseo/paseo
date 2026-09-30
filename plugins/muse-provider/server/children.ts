import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { MspConnection, type Notification } from "./connection.js";
import { Timeline } from "./timeline.js";
import {
  childSessionSchema,
  pageSchema,
  itemNotificationSchema,
  notificationSchema,
  deltaSchema,
  type WireItem,
} from "./wire.js";

interface Child {
  timeline: Timeline;
  cursor: string | undefined;
}
export class Children {
  private readonly children = new Map<string, Child>();
  constructor(
    private readonly host: MspConnection,
    private readonly parentId: string,
    private readonly cwd: string,
    private readonly emit: (event: ProviderEvent) => void,
  ) {}

  async update(item: WireItem): Promise<void> {
    if (
      !item.childSessionId ||
      !(
        item.kind === "subagent" ||
        item.kind === "workflow" ||
        item.tool === "workflow" ||
        item.tool.startsWith("subagent_")
      )
    )
      return;
    const id = item.childSessionId;
    if (!this.children.has(id)) {
      const { session } = await this.host.request(
        "session/read",
        { sessionId: id },
        childSessionSchema,
      );
      this.emit({
        type: "session.opened",
        sessionId: id,
        parentSessionId: this.parentId,
        toolCallId: item.callId ?? item.itemId,
        capabilities: [],
        restoration: "parent",
        cwd: session.workspaceRoot ?? this.cwd,
        title: session.title,
      });
      this.children.set(id, {
        timeline: new Timeline(this.host, id, id, this.emit),
        cursor: undefined,
      });
    }
    await this.page(id);
  }
  async notify(id: string, event: Notification): Promise<void> {
    const child = this.children.get(id);
    if (!child) return;
    if (["item/started", "item/updated", "item/completed"].includes(event.method)) {
      const { item } = itemNotificationSchema.parse(event.params);
      await child.timeline.fold(item);
    } else if (event.method === "item/delta") child.timeline.delta(deltaSchema.parse(event.params));
  }
  async refresh(): Promise<void> {
    for (const id of this.children.keys()) await this.page(id);
  }
  private async page(id: string): Promise<void> {
    const child = this.children.get(id)!;
    let next: string | null;
    do {
      const page = await this.host.request(
        "view/page",
        { sessionId: id, cursor: child.cursor, limit: 1000, direction: "forward" },
        pageSchema,
      );
      for (const event of page.events) {
        await this.notify(id, event);
        const envelope = notificationSchema.parse(event.params);
        if (envelope.viewCursor) child.cursor = envelope.viewCursor;
      }
      next = page.nextCursor;
      if (next !== null) child.cursor = next;
    } while (next !== null);
  }
  close(): void {
    for (const sessionId of this.children.keys()) this.emit({ type: "session.closed", sessionId });
    this.children.clear();
  }
}
