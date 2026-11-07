import type { OpenCodeEvent, SessionMessageInfo, ShellInfo } from "@opencode/client";
import type { AgentStreamEvent } from "../../../agent-sdk-types.js";
import type { V2Api } from "./api.js";
import { messages } from "./history.js";

type InventoryEvent = Extract<AgentStreamEvent, { type: "background_work" }>;
type RelevantEvent = Extract<
  OpenCodeEvent,
  {
    type:
      | "session.tool.input.started"
      | "session.tool.input.ended"
      | "session.tool.success"
      | "shell.created"
      | "shell.exited"
      | "shell.deleted";
  }
>;

export class OpenCodeBackgroundInventory {
  private generation = 0;
  private client: V2Api | null = null;
  private loading = false;
  private pending = false;
  private dirty = false;
  private retrying = false;
  private events: RelevantEvent[] = [];
  private names = new Map<string, string>();
  private inputs = new Map<string, unknown>();
  private descriptions = new Map<string, string>();
  private promoted = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private current: InventoryEvent | null = null;
  private readonly listeners = new Set<() => void>();
  async stopItem(id: string): Promise<void> {
    const client = this.client;
    const generation = this.generation;
    if (!client || !this.current?.items?.some((item) => item.id === id && item.canStop))
      throw new Error("Background shell is no longer available");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let disconnected!: () => void;
    const lost = new Promise<never>((_, reject) => {
      disconnected = () => {
        if (generation !== this.generation)
          reject(new Error("Background shell connection changed"));
      };
      this.listeners.add(disconnected);
      timer = setTimeout(() => reject(new Error("Background shell stop timed out")), 10000);
    });
    try {
      await Promise.race([client.shell.remove({ id, location: { directory: this.cwd } }), lost]);
    } finally {
      clearTimeout(timer);
      this.listeners.delete(disconnected);
    }
    if (generation !== this.generation) throw new Error("Background shell connection changed");
    await new Promise<void>((resolve, reject) => {
      const confirmationTimer = setTimeout(
        () => finish(new Error("Background shell confirmation timed out")),
        15000,
      );
      const finish = (error?: Error) => {
        clearTimeout(confirmationTimer);
        this.listeners.delete(check);
        if (error) reject(error);
        else resolve();
      };
      const check = () => {
        if (generation !== this.generation)
          finish(new Error("Background shell connection changed"));
        else if (this.current?.items && !this.current.items.some((item) => item.id === id))
          finish();
      };
      this.listeners.add(check);
      this.dirty = true;
      this.refresh();
    });
  }
  private notify() {
    for (const listener of this.listeners) listener();
  }
  constructor(options: {
    id: string;
    cwd: string;
    emit: (event: InventoryEvent) => void;
    report: (error: unknown) => void;
  }) {
    this.id = options.id;
    this.cwd = options.cwd;
    this.emit = options.emit;
    this.report = options.report;
  }
  private readonly id: string;
  private readonly cwd: string;
  private readonly emit: (event: InventoryEvent) => void;
  private readonly report: (error: unknown) => void;
  snapshot() {
    return this.current;
  }
  start(client: V2Api) {
    this.disconnect();
    this.client = client;
    this.loading = true;
    this.events = [];
    const generation = this.generation;
    void this.bootstrap(client, generation);
  }
  disconnect(lost = false) {
    this.generation++;
    this.notify();
    this.client = null;
    this.loading = false;
    this.pending = false;
    this.dirty = false;
    this.retrying = false;
    this.events = [];
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (lost) {
      this.promoted.clear();
      this.descriptions.clear();
      this.current = null;
      this.emit({ type: "background_work", provider: "opencode", items: null });
    } else if (this.current?.items?.some((item) => item.canStop)) {
      // Keep stale rows visible, but revoke their stop tokens until this generation's
      // roster confirms ownership again.
      const items = this.current.items.map((item) => ({
        id: item.id,
        kind: item.kind,
        description: item.description,
        ...(item.command ? { command: item.command } : {}),
      }));
      this.current = { type: "background_work", provider: "opencode", items };
      this.emit(this.current);
    }
  }
  private async bootstrap(client: V2Api, generation: number) {
    try {
      const history = await messages(client, this.id);
      if (generation !== this.generation) return;
      this.names = new Map();
      this.inputs = new Map();
      // Rewinds can remove launch messages without stopping the shell. Keep known
      // promotions until the current provider roster confirms they are gone.
      this.readHistory(history);
      for (const event of this.events) this.apply(event);
      this.events = [];
      this.loading = false;
      this.dirty = true;
      this.refresh();
    } catch (error) {
      if (generation === this.generation) {
        this.report(error);
        this.schedule(() => void this.bootstrap(client, generation), true);
      }
    }
  }
  private readHistory(history: readonly SessionMessageInfo[]) {
    for (const message of history) {
      if (message.type !== "assistant") continue;
      for (const part of message.content) {
        if (part.type !== "tool") continue;
        if (part.state.status === "completed") {
          if (part.name === "shell") this.promote(part.state.metadata, part.state.input);
        } else if (part.state.status !== "error") {
          const key = `${message.id}:${part.id}`;
          this.names.set(key, part.name);
          if (part.name === "shell") this.inputs.set(key, part.state.input);
        }
      }
    }
  }
  private promote(metadata: { [key: string]: unknown } | undefined, input?: unknown) {
    if (metadata?.status === "running" && typeof metadata.shellID === "string") {
      this.promoted.add(metadata.shellID);
      if (
        input &&
        typeof input === "object" &&
        "description" in input &&
        typeof input.description === "string" &&
        input.description.trim()
      )
        this.descriptions.set(metadata.shellID, input.description.trim());
    }
  }
  observe(event: OpenCodeEvent) {
    if (event.type === "session.revert.committed" && event.data.sessionID === this.id) {
      if (this.client) this.start(this.client);
      return;
    }
    if (
      event.type !== "shell.created" &&
      event.type !== "shell.exited" &&
      event.type !== "shell.deleted" &&
      event.type !== "session.tool.input.started" &&
      event.type !== "session.tool.input.ended" &&
      event.type !== "session.tool.success"
    )
      return;
    if ("sessionID" in event.data && event.data.sessionID !== this.id) return;
    if (!this.client) return;
    if (this.loading) {
      this.events.push(event);
      return;
    }
    this.apply(event);
    if (event.type !== "session.tool.input.started" && event.type !== "session.tool.input.ended") {
      this.dirty = true;
      if (!this.retrying) this.refresh();
    }
  }
  private apply(event: RelevantEvent) {
    if (event.type === "session.tool.input.started")
      this.names.set(`${event.data.assistantMessageID}:${event.data.id}`, event.data.name);
    if (
      event.type === "session.tool.input.ended" &&
      this.names.get(`${event.data.assistantMessageID}:${event.data.id}`) === "shell"
    ) {
      try {
        this.inputs.set(
          `${event.data.assistantMessageID}:${event.data.id}`,
          JSON.parse(event.data.text),
        );
      } catch {
        /* A malformed tool input supplies no presentation metadata. */
      }
    }
    if (
      event.type === "session.tool.success" &&
      this.names.get(`${event.data.assistantMessageID}:${event.data.id}`) === "shell"
    )
      this.promote(
        event.data.metadata,
        this.inputs.get(`${event.data.assistantMessageID}:${event.data.id}`),
      );
    if (event.type === "session.tool.success") {
      this.names.delete(`${event.data.assistantMessageID}:${event.data.id}`);
      this.inputs.delete(`${event.data.assistantMessageID}:${event.data.id}`);
    }
  }
  private refresh() {
    if (!this.client || this.loading || this.pending) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = true;
    this.dirty = false;
    const generation = this.generation;
    const client = this.client;
    let failed = false;
    void client.shell
      .list({ location: { directory: this.cwd } })
      .then((result) => {
        if (generation !== this.generation || this.dirty) return undefined;
        this.publish(result.data);
        return undefined;
      })
      .catch((error: unknown) => {
        if (generation === this.generation) {
          failed = true;
          this.report(error);
        }
      })
      .finally(() => {
        if (generation !== this.generation) return;
        this.pending = false;
        if (this.dirty && !failed) this.refresh();
        else if (failed || this.current?.items?.length) this.schedule(() => this.refresh(), failed);
      });
  }
  private schedule(callback: () => void, retry = false) {
    this.retrying = retry;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.retrying = false;
      callback();
    }, 5000);
    this.timer.unref();
  }
  private publish(shells: ShellInfo[]) {
    const live = new Set(
      shells
        .filter((shell) => shell.status === "running" && shell.metadata.sessionID === this.id)
        .map((shell) => shell.id),
    );
    this.promoted = new Set([...this.promoted].filter((id) => live.has(id)));
    for (const id of this.descriptions.keys()) if (!live.has(id)) this.descriptions.delete(id);
    this.current = {
      type: "background_work",
      provider: "opencode",
      items: shells
        .filter(
          (shell) =>
            shell.status === "running" &&
            shell.metadata.sessionID === this.id &&
            this.promoted.has(shell.id),
        )
        .map((shell) => ({
          id: shell.id,
          kind: "shell",
          description: this.descriptions.get(shell.id) ?? null,
          command: shell.command || undefined,
          canStop: true,
        })),
    };
    this.emit(this.current);
    this.notify();
  }
}
