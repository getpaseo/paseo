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
  releases = 0;
  prompt: V2Api["session"]["prompt"] = async (input) => {
    this.prompts.push(input.text);
  };
  wait: V2Api["session"]["wait"] = async () => undefined;
  interrupt: V2Api["session"]["interrupt"] = async () => {
    this.info.outcome = "interrupted";
    return { interrupted: true };
  };
  private pendingEvents: OpenCodeEvent[] = [];
  private notify: (() => void) | null = null;
  push(event: OpenCodeEvent) {
    this.pendingEvents.push(event);
    this.notify?.();
  }

  readonly api: V2Api = {
    health: { get: unexpected },
    plugin: { awaitActivation: async () => undefined, list: unexpected },
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
    mcp: { add: unexpected, list: unexpected },
    message: {
      list: async (input) => {
        if (input.cursor && input.order) throw new Error("cursor cannot be combined with order");
        return { data: [...this.history], cursor: {} };
      },
    },
    permission: { list: async () => [], reply: unexpected, rules: unexpected },
    form: { list: async () => [], reply: unexpected, cancel: unexpected },
    session: {
      create: async (input = {}) => {
        this.creates.push(input);
        return this.info;
      },
      get: async () => this.info,
      list: async () => ({ data: [], cursor: {} }),
      active: async () => ({}),
      remove: async () => undefined,
      switchAgent: unexpected,
      switchModel: unexpected,
      environment: unexpected,
      instructions: { entry: { list: unexpected, put: unexpected, remove: unexpected } },
      prompt: (input, options) => this.prompt(input, options),
      wait: (input, options) => this.wait(input, options),
      interrupt: (input, options) => this.interrupt(input, options),
      command: unexpected,
      compact: unexpected,
      revert: { stage: unexpected, clear: unexpected, commit: unexpected },
      log: unexpected,
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
