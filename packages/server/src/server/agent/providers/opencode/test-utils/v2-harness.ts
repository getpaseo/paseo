import type {
  OpenCodeEvent,
  SessionInfo,
  SessionMessageInfo,
  SessionCreateInput,
} from "@opencode/client";
import type { V2Api } from "../v2/api.js";
import type { V2Connection } from "../v2/runtime.js";

function unexpected(): never {
  throw new Error("Unexpected OpenCode v2 test operation");
}

export type HarnessSessionInfo = SessionInfo & {
  time: SessionInfo["time"] & { busy?: number };
};

export class V2Harness {
  readonly info: HarnessSessionInfo = {
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
  readonly instructions = new Map<string, string>();
  releases = 0;
  releaseStopsServer = false;
  active = false;
  activeReads = 0;
  autoComplete = true;
  sessionGetError: Error | null = null;
  private clock = 1;
  private readonly activityListeners = new Set<() => void>();
  constructor(private sequence = 0) {}
  private executionCount = 0;
  private tick(): number {
    this.clock = Math.max(
      this.clock + 1,
      (this.info.time.idle ?? 0) + 1,
      (this.info.time.busy ?? 0) + 1,
      this.info.time.updated + 1,
    );
    return this.clock;
  }
  pingActivity() {
    for (const listener of this.activityListeners) listener();
  }
  startExecution(publish = true) {
    this.active = true;
    const now = this.tick();
    this.info.time.busy = now;
    this.info.time.updated = now;
    this.push(
      {
        id: `execution-${++this.sequence}`,
        created: this.sequence,
        type: "session.execution.started",
        durable: { aggregateID: this.info.id, seq: this.sequence, version: 1 },
        data: { sessionID: this.info.id },
      },
      publish,
    );
  }
  finishExecution(
    outcome: "succeeded" | "interrupted" | "failed" = "succeeded",
    publish = true,
    error?: { type?: string; message: string },
  ) {
    this.active = false;
    const now = this.tick();
    this.info.outcome = outcome;
    this.info.time.idle = now;
    this.info.time.updated = now;
    if (this.history.at(-1)?.type !== "idle" || outcome === "failed") {
      this.history.push({
        id: `idle-${this.sequence + 1}`,
        type: "idle",
        outcome,
        time: { created: now },
        ...(outcome === "failed" && error
          ? { error: { type: error.type ?? "provider", message: error.message } }
          : {}),
      } as SessionMessageInfo);
    }
    const common = {
      id: `execution-${++this.sequence}`,
      created: this.sequence,
      durable: { aggregateID: this.info.id, seq: this.sequence, version: 1 as const },
    };
    let event: OpenCodeEvent;
    if (outcome === "succeeded") {
      event = { ...common, type: "session.execution.succeeded", data: { sessionID: this.info.id } };
    } else if (outcome === "failed") {
      event = {
        ...common,
        type: "session.execution.failed",
        data: {
          sessionID: this.info.id,
          error: {
            type: error?.type ?? "provider",
            message: error?.message ?? "OpenCode execution failed",
          },
        },
      };
    } else {
      event = {
        ...common,
        type: "session.execution.interrupted",
        data: { sessionID: this.info.id, reason: "user" },
      };
    }
    this.push(event, publish);
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
      this.executionCount += 1;
    }
    if (!publish) return;
    this.pendingEvents.push(event);
    this.notify?.();
  }

  readonly api: V2Api = {
    server: { info: unexpected },
    shell: {
      remove: unexpected,
      list: async () => ({ location: { directory: this.info.location.directory }, data: [] }),
    },
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
    // Paseo hosts session MCP servers itself; OpenCode's location-wide MCP is never used.
    mcp: { add: unexpected, list: unexpected },
    message: {
      list: async (input) => {
        if (input.cursor && input.order) throw new Error("cursor cannot be combined with order");
        let order: "asc" | "desc" = input.order ?? "desc";
        let offset = 0;
        if (input.cursor) {
          const parsed = JSON.parse(input.cursor) as { order: "asc" | "desc"; offset: number };
          order = parsed.order;
          offset = parsed.offset;
        }
        const ordered = order === "desc" ? this.history.toReversed() : [...this.history];
        const filtered = input.type
          ? ordered.filter((message) => message.type === input.type)
          : ordered;
        const limit = input.limit ?? 50;
        const data = filtered.slice(offset, offset + limit);
        const nextOffset = offset + data.length;
        const next =
          nextOffset < filtered.length ? JSON.stringify({ order, offset: nextOffset }) : undefined;
        return { data, cursor: next ? { next } : {} };
      },
    },
    permission: { list: async () => [], reply: unexpected },
    session: {
      inbox: { list: async () => [] },
      form: { list: async () => [], reply: unexpected, cancel: unexpected },
      create: async (input = {}) => {
        this.creates.push(input);
        return this.info;
      },
      get: async () => {
        if (this.sessionGetError) throw this.sessionGetError;
        return this.info;
      },
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
      instructions: {
        entry: {
          list: async () => [...this.instructions].map(([key, value]) => ({ key, value })),
          put: async ({ key, value }) => {
            this.instructions.set(key, String(value));
          },
          remove: async ({ key }) => {
            this.instructions.delete(key);
          },
        },
      },
      prompt: async (input, options) => {
        const before = this.executionCount;
        await this.prompt(input, options);
        if (this.autoComplete && this.executionCount === before && this.info.outcome !== "failed")
          this.finishExecution();
      },
      interrupt: (input, options) => this.interrupt(input, options),
      command: unexpected,
      compact: unexpected,
      revert: { stage: unexpected, clear: unexpected, commit: unexpected },
    },
    event: { subscribe: (options) => this.events(options) },
  };
  readonly connection: V2Connection = {
    bindSession: async () => {},
    unbindSession: async () => {},
    refreshLocation: async () => {},
    client: this.api,
    release: async () => {
      this.releases += 1;
    },
    retain: () => this.connection,
    releaseStopsServer: () => this.releaseStopsServer,
    exited: new Promise<Error>(() => undefined),
  };
  readonly runtime = { acquire: async () => this.connection, shutdown: async () => undefined };

  private async *events(options?: {
    signal?: AbortSignal;
    onActivity?: () => void;
  }): AsyncGenerator<OpenCodeEvent> {
    const signal = options?.signal;
    const onActivity = options?.onActivity;
    if (onActivity) this.activityListeners.add(onActivity);
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
      if (onActivity) this.activityListeners.delete(onActivity);
    }
  }
}
