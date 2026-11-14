import type { ProviderEvent } from "@getpaseo/plugin/server/provider";
import { MspConnection, type Notification } from "./connection.js";
import { Timeline, subagentOutcome } from "./timeline.js";
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
  ended: boolean;
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
    if (!this.children.has(id)) await this.open(id, item);
    await this.read(id);
    this.end(id, item);
  }
  // A child's transcript is a projection: Muse 1.4.7 can refuse to read a subagent's view right
  // after creating it, and that must not fail the parent. A child whose session/read fails still
  // opens, without its title and workspace, so a later item update or refresh() can read it: the
  // item may be the child's last revision, which a replay would not deliver again.
  private async open(id: string, item: WireItem): Promise<void> {
    let session;
    try {
      ({ session } = await this.host.request(
        "session/read",
        { sessionId: id },
        childSessionSchema,
      ));
    } catch (error) {
      this.readFailed(id, error);
    }
    this.emit({
      type: "session.opened",
      sessionId: id,
      parentSessionId: this.parentId,
      toolCallId: item.callId ?? item.itemId,
      capabilities: [],
      restoration: "parent",
      cwd: session?.workspaceRoot ?? this.cwd,
      title: session?.title,
    });
    this.children.set(id, {
      timeline: new Timeline(this.host, id, id, this.emit),
      cursor: undefined,
      ended: false,
    });
  }
  // The next item update or refresh() reads a failed child again from the same cursor.
  private async read(id: string): Promise<void> {
    try {
      await this.page(id);
    } catch (error) {
      this.readFailed(id, error);
    }
  }
  private readFailed(id: string, error: unknown): void {
    process.stderr.write(
      `Muse child ${id} view read failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
  // Muse sends no turn events for a child, so the parent's item is the only record that it finished.
  // A subagent_* tool call completes when the spawn is accepted, so only subagent and workflow items count.
  private end(id: string, item: WireItem): void {
    const child = this.children.get(id)!;
    const outcome =
      item.kind === "subagent" || item.kind === "workflow" ? subagentOutcome(item) : undefined;
    if (!outcome || child.ended) return;
    child.ended = true;
    this.emit({
      type: "session.turn",
      sessionId: id,
      turnId: item.itemId,
      state: outcome,
      ...(outcome === "failed"
        ? { error: { message: item.result?.errorKind ?? "Muse subagent failed" } }
        : {}),
    });
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
    for (const id of this.children.keys()) await this.read(id);
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
