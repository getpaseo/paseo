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
  private readonly threads = new Set<string>();
  private origins = new Map<string, { threadId: string; processId: string }>();
  private pending = false;
  private dirty = false;
  private unsupported = false;
  private retrying = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private current: InventoryEvent | null = null;
  private readonly listeners = new Set<() => void>();

  async stopItem(id: string): Promise<void> {
    const client = this.client;
    const origin = this.origins.get(id);
    const generation = this.generation;
    if (!client || !origin || !this.current?.items?.some((item) => item.id === id))
      throw new Error("Background terminal is no longer available");
    const result = z
      .object({ terminated: z.boolean() })
      .parse(
        await client.request(
          "thread/backgroundTerminals/terminate",
          { threadId: origin.threadId, processId: origin.processId },
          10000,
        ),
      );
    if (generation !== this.generation) throw new Error("Background terminal connection changed");
    if (!result.terminated) throw new Error("Background terminal was not terminated");
    await this.waitUntilAbsent(id, generation);
  }

  private waitUntilAbsent(id: string, generation: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => finish(new Error("Background terminal confirmation timed out")),
        15000,
      );
      const finish = (error?: Error) => {
        clearTimeout(timer);
        this.listeners.delete(check);
        if (error) reject(error);
        else resolve();
      };
      const check = () => {
        if (generation !== this.generation)
          finish(new Error("Background terminal connection changed"));
        else if (this.current?.items && !this.current.items.some((item) => item.id === id))
          finish();
      };
      this.listeners.add(check);
      this.changed(this.thread);
    });
  }
  private notify() {
    for (const listener of this.listeners) listener();
  }

  constructor(private readonly emit: (event: InventoryEvent) => void) {}

  snapshot() {
    return this.current;
  }
  start({ client, thread }: { client: Client; thread: string | null }) {
    this.stop();
    this.client = client;
    this.thread = thread;
    this.unsupported = false;
    this.changed(thread);
  }
  stop() {
    this.generation++;
    this.notify();
    this.client = null;
    this.thread = null;
    this.threads.clear();
    this.origins.clear();
    this.pending = false;
    this.dirty = false;
    this.retrying = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.current) this.emit({ type: "background_work", provider: "codex", items: null });
    this.current = null;
  }
  changed(thread: string | null) {
    this.thread = thread;
    if (thread) this.threads.add(thread);
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
    const threads = [...this.threads];
    void (async () => {
      let failed = false;
      try {
        const { items, origins, activeThreads } = await readInventories(client, threads);
        if (generation !== this.generation || this.dirty) return;
        this.origins = origins;
        this.threads.clear();
        for (const threadId of activeThreads) this.threads.add(threadId);
        if (this.thread) this.threads.add(this.thread);
        this.current = { type: "background_work", provider: "codex", items };
        this.emit(this.current);
        this.notify();
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

async function readInventories(client: Client, threads: string[]) {
  const items: NonNullable<InventoryEvent["items"]> = [];
  const origins = new Map<string, { threadId: string; processId: string }>();
  const activeThreads = new Set<string>();
  for (const threadId of threads) {
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
      for (const row of page.data) {
        const id = JSON.stringify([threadId, row.processId]);
        origins.set(id, { threadId, processId: row.processId });
        activeThreads.add(threadId);
        items.push({
          id,
          kind: "shell",
          canStop: true,
          description: null,
          ...(row.command ? { command: row.command } : {}),
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
  }
  return { items, origins, activeThreads };
}
