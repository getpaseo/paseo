import { z } from "zod";
import type { AgentStreamEvent } from "../../agent-sdk-types.js";
import { CodexAppServerRpcError } from "./app-server-transport.js";

type InventoryEvent = Extract<AgentStreamEvent, { type: "background_work" }>;
interface Client {
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
}

export class CodexBackgroundInventory {
  private generation = 0;
  private client: Client | null = null;
  private thread: string | null = null;
  private pending = false;
  private dirty = false;
  private unsupported = false;
  private retrying = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private current: InventoryEvent | null = null;

  constructor(private readonly emit: (event: InventoryEvent) => void) {}

  snapshot() {
    return this.current;
  }
  start(client: Client, thread: string | null) {
    this.stop();
    this.client = client;
    this.thread = thread;
    this.unsupported = false;
    this.changed(thread);
  }
  stop() {
    this.generation++;
    this.client = null;
    this.thread = null;
    this.pending = false;
    this.dirty = false;
    this.retrying = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.current) this.emit({ type: "background_work", provider: "codex", items: null });
    this.current = null;
  }
  changed(thread: string | null) {
    if (this.thread !== thread) {
      this.generation++;
      this.thread = thread;
      this.pending = false;
      this.dirty = false;
      this.retrying = false;
      if (this.timer) clearTimeout(this.timer);
      this.timer = null;
      if (this.current) this.emit({ type: "background_work", provider: "codex", items: null });
      this.current = null;
    }
    if (!this.client || !thread || this.unsupported) return;
    this.dirty = true;
    if (!this.retrying) this.refresh();
  }
  private refresh() {
    if (this.pending || !this.client || !this.thread || this.unsupported) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = true;
    this.dirty = false;
    const generation = this.generation;
    const client = this.client;
    const threadId = this.thread;
    void (async () => {
      let failed = false;
      try {
        const items: NonNullable<InventoryEvent["items"]> = [];
        let cursor: string | null = null;
        do {
          const page = z
            .object({
              data: z.array(z.object({ processId: z.string(), command: z.string() })),
              nextCursor: z.string().nullable(),
            })
            .parse(
              await client.request(
                "thread/backgroundTerminals/list",
                { threadId, ...(cursor ? { cursor } : {}) },
                10_000,
              ),
            );
          items.push(
            ...page.data.map((row) => ({
              id: row.processId,
              kind: "shell",
              description: row.command || null,
            })),
          );
          cursor = page.nextCursor;
        } while (cursor);
        if (generation !== this.generation || this.dirty) return;
        this.current = { type: "background_work", provider: "codex", items };
        this.emit(this.current);
      } catch (error) {
        failed = true;
        if (
          generation === this.generation &&
          error instanceof CodexAppServerRpcError &&
          error.code === -32601
        )
          this.unsupported = true;
      } finally {
        if (generation === this.generation) {
          this.pending = false;
          if (this.dirty && !failed && !this.unsupported) this.refresh();
          else if (!this.unsupported && (failed || this.current?.items?.length)) {
            this.retrying = failed;
            this.timer = setTimeout(() => {
              this.timer = null;
              this.retrying = false;
              this.refresh();
            }, 5000);
            this.timer.unref();
          }
        }
      }
    })();
  }
}
