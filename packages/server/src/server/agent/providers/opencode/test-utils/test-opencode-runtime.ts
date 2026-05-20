import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";

import type { OpenCodeRuntime, OpenCodeServerAcquisition } from "../runtime.js";

interface OpenCodeResponse {
  data?: unknown;
  error?: unknown;
}

export class TestOpenCodeRuntime implements OpenCodeRuntime {
  readonly acquisitions: Array<{
    force: boolean;
    env?: Record<string, string>;
    releaseCount: number;
  }> = [];
  readonly clientCreations: Array<{ baseUrl: string; directory: string }> = [];
  private readonly clients: TestOpenCodeClient[] = [];

  server = { port: 1234, url: "http://127.0.0.1:1234" };

  enqueueClient(client: TestOpenCodeClient): void {
    this.clients.push(client);
  }

  async acquireServer(options: {
    force: boolean;
    env?: Record<string, string>;
  }): Promise<OpenCodeServerAcquisition> {
    const acquisition = { force: options.force, env: options.env, releaseCount: 0 };
    this.acquisitions.push(acquisition);
    return {
      server: this.server,
      release: () => {
        acquisition.releaseCount += 1;
      },
    };
  }

  async ensureServerRunning(): Promise<{ port: number; url: string }> {
    return this.server;
  }

  createClient(options: { baseUrl: string; directory: string }): OpencodeClient {
    this.clientCreations.push(options);
    const client = this.clients.shift() ?? new TestOpenCodeClient();
    return client.asSdkClient();
  }

  async shutdown(): Promise<void> {}
}

export class TestOpenCodeClient {
  readonly calls = {
    appAgents: [] as unknown[],
    commandList: [] as unknown[],
    eventSubscribe: [] as unknown[],
    experimentalSessionList: [] as unknown[],
    globalEvent: [] as unknown[],
    permissionReply: [] as unknown[],
    providerList: [] as unknown[],
    questionReject: [] as unknown[],
    questionReply: [] as unknown[],
    sessionAbort: [] as unknown[],
    sessionCommand: [] as unknown[],
    sessionCreate: [] as unknown[],
    sessionDelete: [] as unknown[],
    sessionMessages: [] as unknown[],
    sessionPromptAsync: [] as unknown[],
    sessionSummarize: [] as unknown[],
    sessionUpdate: [] as unknown[],
  };

  appAgentsResponse: OpenCodeResponse = { data: [] };
  commandListResponse: OpenCodeResponse = { data: [] };
  eventStream: AsyncIterable<unknown>;
  experimentalSessionListResponse: OpenCodeResponse = { data: [] };
  permissionReplyResponse: OpenCodeResponse = {};
  providerListResponse: OpenCodeResponse = { data: { connected: [], all: [] } };
  providerListImplementation: (() => Promise<OpenCodeResponse>) | null = null;
  questionRejectResponse: OpenCodeResponse = {};
  questionReplyResponse: OpenCodeResponse = {};
  sessionAbortResponse: OpenCodeResponse = {};
  sessionCommandError: unknown = null;
  sessionCommandEvents: unknown[] = [idleEvent()];
  sessionCommandResponse: OpenCodeResponse = {};
  sessionCreateResponse: OpenCodeResponse = { data: { id: "session-1" } };
  sessionDeleteResponse: OpenCodeResponse = {};
  sessionMessagesResponse: OpenCodeResponse = { data: [] };
  sessionPromptAsyncEvents: unknown[] = [idleEvent()];
  sessionPromptAsyncResponse: OpenCodeResponse = {};
  sessionSummarizeResponse: OpenCodeResponse = { data: {} };
  sessionUpdateResponse: OpenCodeResponse = {};
  private readonly queuedEventStream = createQueuedEventStream();

  constructor() {
    this.eventStream = this.queuedEventStream.stream;
  }

  emitEvent(event: unknown): void {
    this.queuedEventStream.emit(event);
  }

  asSdkClient(): OpencodeClient {
    return {
      app: {
        agents: async (parameters: unknown) => {
          this.calls.appAgents.push(parameters);
          return this.appAgentsResponse;
        },
      },
      command: {
        list: async (parameters: unknown) => {
          this.calls.commandList.push(parameters);
          return this.commandListResponse;
        },
      },
      event: {
        subscribe: async (parameters: unknown, options: unknown) => {
          this.calls.eventSubscribe.push({ parameters, options });
          return { stream: this.eventStream };
        },
      },
      experimental: {
        session: {
          list: async (parameters: unknown) => {
            this.calls.experimentalSessionList.push(parameters);
            return this.experimentalSessionListResponse;
          },
        },
      },
      global: {
        event: async (options: unknown) => {
          this.calls.globalEvent.push(options);
          return { stream: this.eventStream };
        },
      },
      mcp: {
        add: async () => ({}),
        connect: async () => ({}),
      },
      permission: {
        reply: async (parameters: unknown) => {
          this.calls.permissionReply.push(parameters);
          return this.permissionReplyResponse;
        },
      },
      provider: {
        list: async (parameters: unknown) => {
          this.calls.providerList.push(parameters);
          return this.providerListImplementation
            ? await this.providerListImplementation()
            : this.providerListResponse;
        },
      },
      question: {
        reject: async (parameters: unknown) => {
          this.calls.questionReject.push(parameters);
          return this.questionRejectResponse;
        },
        reply: async (parameters: unknown) => {
          this.calls.questionReply.push(parameters);
          return this.questionReplyResponse;
        },
      },
      session: {
        abort: async (parameters: unknown) => {
          this.calls.sessionAbort.push(parameters);
          return this.sessionAbortResponse;
        },
        command: async (parameters: unknown) => {
          this.calls.sessionCommand.push(parameters);
          if (this.sessionCommandError) {
            throw this.sessionCommandError;
          }
          for (const event of this.sessionCommandEvents) {
            this.emitEvent(event);
          }
          return this.sessionCommandResponse;
        },
        create: async (parameters: unknown) => {
          this.calls.sessionCreate.push(parameters);
          return this.sessionCreateResponse;
        },
        delete: async (parameters: unknown) => {
          this.calls.sessionDelete.push(parameters);
          return this.sessionDeleteResponse;
        },
        messages: async (parameters: unknown) => {
          this.calls.sessionMessages.push(parameters);
          return this.sessionMessagesResponse;
        },
        promptAsync: async (parameters: unknown) => {
          this.calls.sessionPromptAsync.push(parameters);
          for (const event of this.sessionPromptAsyncEvents) {
            this.emitEvent(event);
          }
          return this.sessionPromptAsyncResponse;
        },
        summarize: async (parameters: unknown) => {
          this.calls.sessionSummarize.push(parameters);
          return this.sessionSummarizeResponse;
        },
        update: async (parameters: unknown) => {
          this.calls.sessionUpdate.push(parameters);
          return this.sessionUpdateResponse;
        },
      },
    } as unknown as OpencodeClient;
  }
}

export function createEventStream(events: unknown[]): AsyncGenerator<unknown> {
  return (async function* () {
    for (const event of events) {
      yield event;
    }
  })();
}

function createQueuedEventStream(): {
  stream: AsyncIterable<unknown>;
  emit: (event: unknown) => void;
} {
  const queue: unknown[] = [];
  const waiters: Array<(result: IteratorResult<unknown>) => void> = [];

  return {
    stream: {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          const event = queue.shift();
          if (event !== undefined) {
            return Promise.resolve({ done: false, value: event });
          }
          return new Promise<IteratorResult<unknown>>((resolve) => {
            waiters.push(resolve);
          });
        },
      }),
    },
    emit: (event: unknown) => {
      const waiter = waiters.shift();
      if (waiter) {
        waiter({ done: false, value: event });
        return;
      }
      queue.push(event);
    },
  };
}

export function idleEvent(): unknown {
  return {
    type: "session.idle",
    properties: { sessionID: "session-1" },
  };
}
