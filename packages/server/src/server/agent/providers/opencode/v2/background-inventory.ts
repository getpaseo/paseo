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
  private promoted = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private current: InventoryEvent | null = null;
  constructor(
    private readonly id: string,
    private readonly cwd: string,
    private readonly emit: (event: InventoryEvent) => void,
    private readonly report: (error: unknown) => void,
  ) {}
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
    this.client = null;
    this.loading = false;
    this.pending = false;
    this.dirty = false;
    this.retrying = false;
    this.events = [];
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (lost) {
      this.current = null;
      this.emit({ type: "background_work", provider: "opencode", items: null });
    }
  }
  private async bootstrap(client: V2Api, generation: number) {
    try {
      const history = await messages(client, this.id);
      if (generation !== this.generation) return;
      this.names = new Map();
      this.promoted = new Set();
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
          if (part.name === "shell") this.promote(part.state.metadata);
        } else if (part.state.status !== "error") {
          this.names.set(`${message.id}:${part.id}`, part.name);
        }
      }
    }
  }
  private promote(metadata: { [key: string]: unknown } | undefined) {
    if (metadata?.status === "running" && typeof metadata.shellID === "string")
      this.promoted.add(metadata.shellID);
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
    if (event.type !== "session.tool.input.started") {
      this.dirty = true;
      if (!this.retrying) this.refresh();
    }
  }
  private apply(event: RelevantEvent) {
    if (event.type === "session.tool.input.started")
      this.names.set(`${event.data.assistantMessageID}:${event.data.id}`, event.data.name);
    if (
      event.type === "session.tool.success" &&
      this.names.get(`${event.data.assistantMessageID}:${event.data.id}`) === "shell"
    )
      this.promote(event.data.metadata);
    if (event.type === "session.tool.success")
      this.names.delete(`${event.data.assistantMessageID}:${event.data.id}`);
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
        .map((shell) => ({ id: shell.id, kind: "shell", description: shell.command || null })),
    };
    this.emit(this.current);
  }
}
