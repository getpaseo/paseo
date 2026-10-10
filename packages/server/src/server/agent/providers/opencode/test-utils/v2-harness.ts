import type {
  OpenCodeEvent,
  SessionInfo,
  SessionMessageInfo,
  SessionCreateInput,
  SessionLogItem,
} from "@opencode/client";
import type { V2Api } from "../v2/api.js";
import type { V2Connection } from "../v2/runtime.js";

function unexpected(): never {
  throw new Error("Unexpected OpenCode v2 test operation");
}

export class V2Harness {
  readonly info: SessionInfo = {
    id: "session",
    projectID: "project",
    location: { directory: "/tmp/project" },
    agent: "build",
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    cost: 0,
    time: { created: 1, updated: 1 },
    outcome: "succeeded",
  };
  readonly history: SessionMessageInfo[] = [];
  readonly creates: SessionCreateInput[] = [];
  readonly prompts: string[] = [];
  readonly environments: Array<{ sessionID: string; variables: Record<string, string> }> = [];
  readonly mcpAdds: string[] = [];
  releases = 0;
  active = false;
  activeReads = 0;
  autoComplete = true;
  constructor(private sequence = 0) {}
  private executions: SessionLogItem[] = [];
  startExecution() {
    this.active = true;
    this.push({
      id: `execution-${++this.sequence}`,
      created: this.sequence,
      type: "session.execution.started",
      durable: { aggregateID: this.info.id, seq: this.sequence, version: 1 },
      data: { sessionID: this.info.id },
    });
  }
  finishExecution(outcome: "succeeded" | "interrupted" = "succeeded", publish = true) {
    this.active = false;
    this.info.outcome = outcome;
    const common = {
      id: `execution-${++this.sequence}`,
      created: this.sequence,
      durable: { aggregateID: this.info.id, seq: this.sequence, version: 1 as const },
    };
    this.push(
      outcome === "succeeded"
        ? { ...common, type: "session.execution.succeeded", data: { sessionID: this.info.id } }
        : {
            ...common,
            type: "session.execution.interrupted",
            data: { sessionID: this.info.id, reason: "user" },
          },
      publish,
    );
  }
  prompt: V2Api["session"]["prompt"] = async (input) => {
    this.prompts.push(input.text);
    if (!this.autoComplete) this.startExecution();
  };
  interrupt: V2Api["session"]["interrupt"] = async () => {
    this.finishExecution("interrupted");
    return { interrupted: true };
  };
  private pendingEvents: OpenCodeEvent[] = [];
  private notify: (() => void) | null = null;
  push(event: OpenCodeEvent, publish = true) {
    if (
      event.type === "session.execution.started" ||
      event.type === "session.execution.succeeded" ||
      event.type === "session.execution.failed" ||
      event.type === "session.execution.interrupted"
    ) {
      this.sequence = Math.max(this.sequence, event.durable.seq);
      this.executions.push(event);
    }
    if (!publish) return;
    this.pendingEvents.push(event);
    this.notify?.();
  }

  readonly api: V2Api = {
    server: { info: unexpected },
    plugin: {
      list: async () => ({
        location: { directory: this.info.location.directory },
        data: [
          { id: "paseo", source: { type: "builtin" }, features: {}, state: { status: "active" } },
        ],
      }),
    },
    agent: {
      list: async () => ({
        location: {
          ...this.info.location,
          project: { id: "project", directory: "/tmp/project", canonical: "/tmp/project" },
        },
        data: [],
      }),
    },
    model: { list: unexpected, default: unexpected },
    provider: { list: unexpected },
    command: { list: unexpected },
    skill: { list: unexpected },
    mcp: {
      add: async (input) => {
        this.mcpAdds.push(input.server);
      },
      list: async (input) => ({
        location: { directory: input?.location?.directory ?? this.info.location.directory },
        data: this.mcpAdds.map((name) => ({
          name,
          status: { status: "connected" as const },
        })),
      }),
    },
    message: {
      list: async (input) => {
        if (input.cursor && input.order) throw new Error("cursor cannot be combined with order");
        return { data: [...this.history], cursor: {} };
      },
    },
    permission: { list: async () => [], reply: unexpected },
    session: {
      form: { list: async () => [], reply: unexpected, cancel: unexpected },
      create: async (input = {}) => {
        this.creates.push(input);
        return this.info;
      },
      get: async () => this.info,
      list: async () => ({ data: [], cursor: {} }),
      active: async () => {
        this.activeReads += 1;
        return this.active ? { [this.info.id]: { type: "running" as const } } : {};
      },
      remove: async () => undefined,
      switchAgent: unexpected,
      switchModel: unexpected,
      environment: async (input) => {
        this.environments.push(input);
      },
      instructions: { entry: { list: unexpected, put: unexpected, remove: unexpected } },
      prompt: async (input, options) => {
        const before = this.executions.length;
        await this.prompt(input, options);
        if (
          this.autoComplete &&
          this.executions.length === before &&
          this.info.outcome !== "failed"
        )
          this.finishExecution();
      },
      interrupt: (input, options) => this.interrupt(input, options),
      command: unexpected,
      compact: unexpected,
      revert: { stage: unexpected, clear: unexpected, commit: unexpected },
      log: (input) => this.executionLog(input.after),
    },
    event: { subscribe: (options) => this.events(options?.signal) },
  };
  readonly connection: V2Connection = {
    client: this.api,
    release: async () => {
      this.releases += 1;
    },
    retain: () => this.connection,
    exited: new Promise<Error>(() => undefined),
  };
  readonly runtime = { acquire: async () => this.connection, shutdown: async () => undefined };

  private async *executionLog(after = 0) {
    for (const event of this.executions) {
      if ("durable" in event && event.durable.seq > after) yield event;
    }
  }

  private async *events(signal?: AbortSignal): AsyncGenerator<OpenCodeEvent> {
    yield { id: "connected", created: 1, type: "server.connected", data: {} };
    const wake = () => this.notify?.();
    signal?.addEventListener("abort", wake);
    try {
      while (true) {
        if (signal?.aborted) return;
        const event = this.pendingEvents.shift();
        if (event) yield event;
        else
          await new Promise<void>((resolve) => {
            this.notify = resolve;
          });
      }
    } finally {
      signal?.removeEventListener("abort", wake);
    }
  }
}
