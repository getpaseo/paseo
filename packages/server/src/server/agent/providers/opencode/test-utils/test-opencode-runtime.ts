import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";

import type { OpenCodeRuntime, OpenCodeServerAcquisition } from "../runtime.js";

interface OpenCodeResponse {
  data?: unknown;
  error?: unknown;
}

export class TestOpenCodeRuntime implements OpenCodeRuntime {
  readonly acquisitions: Array<{ force: boolean; releaseCount: number }> = [];
  readonly clientCreations: Array<{ baseUrl: string; directory: string }> = [];
  private readonly clients: TestOpenCodeClient[] = [];

  server = { port: 1234, url: "http://127.0.0.1:1234" };

  enqueueClient(client: TestOpenCodeClient): void {
    this.clients.push(client);
  }

  async acquireServer(options: { force: boolean }): Promise<OpenCodeServerAcquisition> {
    const acquisition = { force: options.force, releaseCount: 0 };
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
  eventStream: AsyncIterable<unknown> = createEventStream([idleEvent()]);
  permissionReplyResponse: OpenCodeResponse = {};
  providerListResponse: OpenCodeResponse = { data: { connected: [], all: [] } };
  providerListImplementation: (() => Promise<OpenCodeResponse>) | null = null;
  questionRejectResponse: OpenCodeResponse = {};
  questionReplyResponse: OpenCodeResponse = {};
  sessionAbortResponse: OpenCodeResponse = {};
  sessionCommandError: unknown = null;
  sessionCommandResponse: OpenCodeResponse = {};
  sessionCreateResponse: OpenCodeResponse = { data: { id: "session-1" } };
  sessionDeleteResponse: OpenCodeResponse = {};
  sessionMessagesResponse: OpenCodeResponse = { data: [] };
  sessionPromptAsyncResponse: OpenCodeResponse = {};
  sessionSummarizeResponse: OpenCodeResponse = { data: {} };
  sessionUpdateResponse: OpenCodeResponse = {};

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

export function idleEvent(): unknown {
  return {
    type: "session.idle",
    properties: { sessionID: "session-1" },
  };
}
