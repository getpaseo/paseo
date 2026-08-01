import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";

import type { OpenCodeServerAcquisition, OpenCodeServerManagerLike } from "../server-manager.js";

interface OpenCodeResponse {
  data?: unknown;
  error?: unknown;
}

export class TestOpenCodeHarness implements OpenCodeServerManagerLike {
  readonly acquisitions: Array<{
    kind: "current" | "new" | "dedicated" | "existing";
    env?: Record<string, string>;
    url?: string;
    releaseCount: number;
  }> = [];
  readonly acquisitionSignals: Array<AbortSignal | undefined> = [];
  readonly clientCreations: Array<{ baseUrl: string; directory: string }> = [];
  private readonly clients: TestOpenCodeClient[] = [];
  releaseImplementation: (() => Promise<void>) | null = null;
  shutdownCallCount = 0;

  server = { port: 1234, url: "http://127.0.0.1:1234" };

  enqueueClient(client: TestOpenCodeClient): void {
    this.clients.push(client);
  }

  async acquireCurrent(signal?: AbortSignal): Promise<OpenCodeServerAcquisition> {
    return this.recordAcquisition({ kind: "current", signal });
  }

  async acquireNew(): Promise<OpenCodeServerAcquisition> {
    return this.recordAcquisition({ kind: "new" });
  }

  async acquireDedicated(
    env: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<OpenCodeServerAcquisition> {
    return this.recordAcquisition({ kind: "dedicated", env, signal });
  }

  acquireExisting(url: string): OpenCodeServerAcquisition | null {
    return url === this.server.url ? this.recordAcquisition({ kind: "existing", url }) : null;
  }

  private recordAcquisition(input: {
    kind: "current" | "new" | "dedicated" | "existing";
    env?: Record<string, string>;
    url?: string;
    signal?: AbortSignal;
  }): OpenCodeServerAcquisition {
    this.acquisitionSignals.push(input.signal);
    const acquisition = {
      kind: input.kind,
      releaseCount: 0,
      ...(input.env ? { env: input.env } : {}),
      ...(input.url ? { url: input.url } : {}),
    };
    this.acquisitions.push(acquisition);
    return {
      server: this.server,
      release: async () => {
        acquisition.releaseCount += 1;
        await this.releaseImplementation?.();
      },
    };
  }

  readonly createClient = (options: { baseUrl: string; directory: string }): OpencodeClient => {
    this.clientCreations.push(options);
    const client = this.clients.shift() ?? new TestOpenCodeClient();
    return client.asSdkClient();
  };

  async shutdown(): Promise<void> {
    this.shutdownCallCount += 1;
  }
}

export class TestOpenCodeClient {
  readonly calls = {
    appAgents: [] as unknown[],
    appAgentsOptions: [] as unknown[],
    commandList: [] as unknown[],
    eventSubscribe: [] as unknown[],
    experimentalSessionList: [] as unknown[],
    globalEvent: [] as unknown[],
    mcpAdd: [] as unknown[],
    mcpConnect: [] as unknown[],
    permissionReply: [] as unknown[],
    providerList: [] as unknown[],
    providerListOptions: [] as unknown[],
    questionReject: [] as unknown[],
    questionReply: [] as unknown[],
    sessionAbort: [] as unknown[],
    sessionAbortOptions: [] as unknown[],
    sessionCommand: [] as unknown[],
    sessionCreate: [] as unknown[],
    sessionDelete: [] as unknown[],
    sessionChildren: [] as unknown[],
    sessionGet: [] as unknown[],
    sessionGetOptions: [] as unknown[],
    sessionMessages: [] as unknown[],
    sessionMessagesOptions: [] as unknown[],
    sessionPromptAsync: [] as unknown[],
    sessionStatus: [] as unknown[],
    sessionSummarize: [] as unknown[],
    sessionUpdate: [] as unknown[],
  };

  appAgentsResponse: OpenCodeResponse = { data: [] };
  commandListResponse: OpenCodeResponse = { data: [] };
  eventStream: AsyncIterable<unknown>;
  experimentalSessionListResponse: OpenCodeResponse = { data: [] };
  mcpAddResponse: OpenCodeResponse = {};
  mcpConnectResponse: OpenCodeResponse = {};
  permissionReplyResponse: OpenCodeResponse = {};
  providerListResponse: OpenCodeResponse = { data: { connected: [], all: [] } };
  providerListImplementation: ((options?: unknown) => Promise<OpenCodeResponse>) | null = null;
  appAgentsImplementation: ((options?: unknown) => Promise<OpenCodeResponse>) | null = null;
  globalEventImplementation:
    | ((options: unknown) => Promise<{ stream: AsyncIterable<unknown> }>)
    | null = null;
  questionRejectResponse: OpenCodeResponse = {};
  questionReplyResponse: OpenCodeResponse = {};
  sessionAbortResponse: OpenCodeResponse = {};
  sessionAbortImplementation:
    | ((parameters: unknown, options?: unknown) => Promise<OpenCodeResponse>)
    | null = null;
  sessionCommandError: unknown = null;
  sessionCommandEvents: unknown[] = [idleEvent()];
  sessionCommandResponse: OpenCodeResponse = {};
  sessionCreateResponse: OpenCodeResponse = { data: { id: "session-1" } };
  sessionCreateImplementation: ((parameters: unknown) => Promise<OpenCodeResponse>) | null = null;
  sessionDeleteResponse: OpenCodeResponse = {};
  sessionDeleteImplementation: ((parameters: unknown) => Promise<OpenCodeResponse>) | null = null;
  sessionChildrenResponses: OpenCodeResponse[] = [];
  sessionChildrenImplementation: ((parameters: unknown) => Promise<OpenCodeResponse>) | null = null;
  sessionGetResponse: OpenCodeResponse = {
    data: { id: "session-1", directory: "/workspace/repo", title: null },
  };
  sessionGetImplementation:
    | ((parameters: unknown, options?: unknown) => Promise<OpenCodeResponse>)
    | null = null;
  sessionMessagesResponse: OpenCodeResponse = { data: [] };
  sessionMessagesImplementation:
    | ((parameters: unknown, options?: unknown) => Promise<OpenCodeResponse>)
    | null = null;
  sessionPromptAsyncEvents: unknown[] = [idleEvent()];
  sessionPromptAsyncResponse: OpenCodeResponse = {};
  sessionStatusResponse: OpenCodeResponse = { data: {} };
  sessionStatusImplementation: ((parameters: unknown) => Promise<OpenCodeResponse>) | null = null;
  sessionSummarizeEvents: unknown[] = [idleEvent()];
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
        agents: async (parameters: unknown, options: unknown) => {
          this.calls.appAgents.push(parameters);
          this.calls.appAgentsOptions.push(options);
          return this.appAgentsImplementation
            ? await this.appAgentsImplementation(options)
            : this.appAgentsResponse;
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
          if (this.globalEventImplementation) {
            return await this.globalEventImplementation(options);
          }
          const signal = (options as { signal?: AbortSignal }).signal;
          return {
            stream: signal ? stopEventStreamOnAbort(this.eventStream, signal) : this.eventStream,
          };
        },
      },
      mcp: {
        add: async (parameters: unknown) => {
          this.calls.mcpAdd.push(parameters);
          return this.mcpAddResponse;
        },
        connect: async (parameters: unknown) => {
          this.calls.mcpConnect.push(parameters);
          return this.mcpConnectResponse;
        },
      },
      permission: {
        reply: async (parameters: unknown) => {
          this.calls.permissionReply.push(parameters);
          return this.permissionReplyResponse;
        },
      },
      provider: {
        list: async (parameters: unknown, options: unknown) => {
          this.calls.providerList.push(parameters);
          this.calls.providerListOptions.push(options);
          return this.providerListImplementation
            ? await this.providerListImplementation(options)
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
        abort: async (parameters: unknown, options?: unknown) => {
          this.calls.sessionAbort.push(parameters);
          this.calls.sessionAbortOptions.push(options);
          return this.sessionAbortImplementation
            ? await this.sessionAbortImplementation(parameters, options)
            : this.sessionAbortResponse;
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
          return this.sessionCreateImplementation
            ? await this.sessionCreateImplementation(parameters)
            : this.sessionCreateResponse;
        },
        delete: async (parameters: unknown) => {
          this.calls.sessionDelete.push(parameters);
          return this.sessionDeleteImplementation
            ? await this.sessionDeleteImplementation(parameters)
            : this.sessionDeleteResponse;
        },
        children: async (parameters: unknown) => {
          this.calls.sessionChildren.push(parameters);
          if (this.sessionChildrenImplementation) {
            return await this.sessionChildrenImplementation(parameters);
          }
          return this.sessionChildrenResponses.shift() ?? { data: [] };
        },
        get: async (parameters: unknown, options?: unknown) => {
          this.calls.sessionGet.push(parameters);
          this.calls.sessionGetOptions.push(options);
          return this.sessionGetImplementation
            ? await this.sessionGetImplementation(parameters, options)
            : this.sessionGetResponse;
        },
        messages: async (parameters: unknown, options?: unknown) => {
          this.calls.sessionMessages.push(parameters);
          this.calls.sessionMessagesOptions.push(options);
          return this.sessionMessagesImplementation
            ? await this.sessionMessagesImplementation(parameters, options)
            : this.sessionMessagesResponse;
        },
        promptAsync: async (parameters: unknown) => {
          this.calls.sessionPromptAsync.push(parameters);
          for (const event of this.sessionPromptAsyncEvents) {
            this.emitEvent(event);
          }
          return this.sessionPromptAsyncResponse;
        },
        status: async (parameters: unknown) => {
          this.calls.sessionStatus.push(parameters);
          return this.sessionStatusImplementation
            ? await this.sessionStatusImplementation(parameters)
            : this.sessionStatusResponse;
        },
        summarize: async (parameters: unknown) => {
          this.calls.sessionSummarize.push(parameters);
          for (const event of this.sessionSummarizeEvents) {
            this.emitEvent(event);
          }
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

function stopEventStreamOnAbort(
  stream: AsyncIterable<unknown>,
  signal: AbortSignal,
): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]: () => {
      const iterator = stream[Symbol.asyncIterator]();
      return {
        next: () => {
          if (signal.aborted) {
            return Promise.resolve({ done: true, value: undefined });
          }
          return new Promise<IteratorResult<unknown>>((resolve, reject) => {
            const onAbort = () => resolve({ done: true, value: undefined });
            signal.addEventListener("abort", onAbort, { once: true });
            void iterator.next().then(
              (result) => {
                signal.removeEventListener("abort", onAbort);
                return resolve(result);
              },
              (error) => {
                signal.removeEventListener("abort", onAbort);
                return reject(error);
              },
            );
          });
        },
      };
    },
  };
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
