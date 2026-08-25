import type {
  AgentListInput,
  AgentListOutput,
  EventSubscribeOutput,
  FormCancelInput,
  FormReplyInput,
  MessageListInput,
  ModelListInput,
  ModelListOutput,
  PermissionReplyInput,
  SessionCreateInput,
  SessionGetInput,
  SessionInfo,
  SessionInboxUser,
  SessionInterruptInput,
  SessionInterruptResponse,
  SessionMessagesResponse,
  SessionPromptInput,
  SessionRemoveInput,
  SessionSwitchAgentInput,
  SessionSwitchModelInput,
} from "@opencode-ai/client";

import type { OpenCodeV2ClientFactory, OpenCodeV2ClientLike } from "../client.js";
import type {
  OpenCodeV2EventSourceInput,
  OpenCodeV2ServerAcquisition,
  OpenCodeV2ServerManagerLike,
} from "../server-manager.js";

export class TestOpenCodeV2Harness implements OpenCodeV2ServerManagerLike {
  readonly acquisitions: Array<{
    kind: "current" | "new" | "dedicated" | "existing";
    env?: Record<string, string>;
    url?: string;
    releaseCount: number;
  }> = [];
  readonly clientCreations: Array<{ baseUrl: string; authorization: string }> = [];
  private readonly clients: TestOpenCodeV2Client[] = [];
  private readonly eventListeners = new Set<(input: OpenCodeV2EventSourceInput) => void>();
  readonly events = {
    ready: async () => undefined,
    subscribe: (listener: (input: OpenCodeV2EventSourceInput) => void) => {
      this.eventListeners.add(listener);
      return () => this.eventListeners.delete(listener);
    },
    close: async () => undefined,
  };

  server = {
    port: 1234,
    url: "http://127.0.0.1:1234",
    password: "test-password",
    authorization: "Basic dGVzdC1wYXNzd29yZA==",
  };

  enqueueClient(client: TestOpenCodeV2Client): void {
    client.observeEvents((input) => {
      for (const listener of this.eventListeners) listener(input);
    });
    this.clients.push(client);
  }

  async acquireCurrent(): Promise<OpenCodeV2ServerAcquisition> {
    return this.recordAcquisition({ kind: "current" });
  }

  async acquireNew(): Promise<OpenCodeV2ServerAcquisition> {
    return this.recordAcquisition({ kind: "new" });
  }

  async acquireDedicated(env: Record<string, string>): Promise<OpenCodeV2ServerAcquisition> {
    return this.recordAcquisition({ kind: "dedicated", env });
  }

  acquireExisting(url: string): OpenCodeV2ServerAcquisition | null {
    return url === this.server.url ? this.recordAcquisition({ kind: "existing", url }) : null;
  }

  private recordAcquisition(input: {
    kind: "current" | "new" | "dedicated" | "existing";
    env?: Record<string, string>;
    url?: string;
  }): OpenCodeV2ServerAcquisition {
    const acquisition = {
      kind: input.kind,
      releaseCount: 0,
      ...(input.env ? { env: input.env } : {}),
      ...(input.url ? { url: input.url } : {}),
    };
    this.acquisitions.push(acquisition);
    return {
      server: this.server,
      events: this.events,
      release: async () => {
        acquisition.releaseCount += 1;
      },
    };
  }

  readonly createClient: OpenCodeV2ClientFactory = (options) => {
    this.clientCreations.push(options);
    const client = this.clients.shift() ?? new TestOpenCodeV2Client();
    return client;
  };

  async shutdown(): Promise<void> {}
}

export class TestOpenCodeV2Client implements OpenCodeV2ClientLike {
  readonly calls = {
    sessionCreate: [] as unknown[],
    sessionPrompt: [] as unknown[],
    sessionInterrupt: [] as unknown[],
    sessionGet: [] as unknown[],
    sessionRemove: [] as unknown[],
    sessionSwitchAgent: [] as unknown[],
    sessionSwitchModel: [] as unknown[],
    messageList: [] as unknown[],
    modelList: [] as unknown[],
    agentList: [] as unknown[],
    permissionReply: [] as unknown[],
    formReply: [] as unknown[],
    formCancel: [] as unknown[],
    eventSubscribe: [] as unknown[],
  };

  sessionCreateResponse: SessionInfo = {
    id: "session-1",
    projectID: "project-1",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
    location: { directory: "/workspace/repo" },
  };
  sessionCreateImplementation: ((input: SessionCreateInput) => Promise<SessionInfo>) | null = null;
  sessionCreateError: unknown = null;

  sessionPromptResponse: SessionInboxUser = {
    id: "msg_1",
    sessionID: "session-1",
    timeCreated: 0,
    type: "user",
    payload: { text: "" },
    delivery: "steer",
  };
  sessionPromptImplementation: ((input: SessionPromptInput) => Promise<SessionInboxUser>) | null =
    null;
  sessionPromptError: unknown = null;

  sessionInterruptResponse: SessionInterruptResponse = { interrupted: true };
  sessionInterruptImplementation:
    | ((input: SessionInterruptInput) => Promise<SessionInterruptResponse>)
    | null = null;
  sessionInterruptError: unknown = null;

  sessionGetResponse: SessionInfo = {
    id: "session-1",
    projectID: "project-1",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 0 },
    location: { directory: "/workspace/repo" },
  };
  sessionGetImplementation: ((input: SessionGetInput) => Promise<SessionInfo>) | null = null;
  sessionGetError: unknown = null;

  sessionRemoveError: unknown = null;

  sessionSwitchAgentError: unknown = null;
  sessionSwitchModelError: unknown = null;

  messageListResponse: SessionMessagesResponse = { data: [], cursor: {} };
  messageListImplementation:
    | ((input: MessageListInput) => Promise<SessionMessagesResponse>)
    | null = null;
  messageListError: unknown = null;

  modelListResponse: ModelListOutput = {
    location: {
      directory: "/workspace/repo",
      project: { id: "project-1", directory: "/workspace/repo", canonical: "/workspace/repo" },
    },
    data: [],
  };
  modelListImplementation: ((input: ModelListInput) => Promise<ModelListOutput>) | null = null;
  modelListError: unknown = null;

  agentListResponse: AgentListOutput = {
    location: {
      directory: "/workspace/repo",
      project: { id: "project-1", directory: "/workspace/repo", canonical: "/workspace/repo" },
    },
    data: [],
  };
  agentListImplementation: ((input: AgentListInput) => Promise<AgentListOutput>) | null = null;
  agentListError: unknown = null;

  permissionReplyError: unknown = null;
  formReplyError: unknown = null;
  formCancelError: unknown = null;

  private readonly queuedEventStream = createQueuedEventStream();
  private eventObserver: ((input: OpenCodeV2EventSourceInput) => void) | null = null;

  emitEvent(event: EventSubscribeOutput): void {
    this.queuedEventStream.emit(event);
    this.eventObserver?.({ type: "event", event });
  }

  observeEvents(observer: (input: OpenCodeV2EventSourceInput) => void): void {
    this.eventObserver = observer;
  }

  async sessionCreate(input: SessionCreateInput): Promise<SessionInfo> {
    this.calls.sessionCreate.push(input);
    if (this.sessionCreateError) {
      throw this.sessionCreateError;
    }
    if (this.sessionCreateImplementation) {
      return await this.sessionCreateImplementation(input);
    }
    return this.sessionCreateResponse;
  }

  async sessionPrompt(input: SessionPromptInput): Promise<SessionInboxUser> {
    this.calls.sessionPrompt.push(input);
    if (this.sessionPromptError) {
      throw this.sessionPromptError;
    }
    if (this.sessionPromptImplementation) {
      return await this.sessionPromptImplementation(input);
    }
    return this.sessionPromptResponse;
  }

  async sessionInterrupt(input: SessionInterruptInput): Promise<SessionInterruptResponse> {
    this.calls.sessionInterrupt.push(input);
    if (this.sessionInterruptError) {
      throw this.sessionInterruptError;
    }
    if (this.sessionInterruptImplementation) {
      return await this.sessionInterruptImplementation(input);
    }
    return this.sessionInterruptResponse;
  }

  async sessionGet(input: SessionGetInput): Promise<SessionInfo> {
    this.calls.sessionGet.push(input);
    if (this.sessionGetError) {
      throw this.sessionGetError;
    }
    if (this.sessionGetImplementation) {
      return await this.sessionGetImplementation(input);
    }
    return this.sessionGetResponse;
  }

  async sessionRemove(input: SessionRemoveInput): Promise<void> {
    this.calls.sessionRemove.push(input);
    if (this.sessionRemoveError) {
      throw this.sessionRemoveError;
    }
  }

  async sessionSwitchAgent(input: SessionSwitchAgentInput): Promise<void> {
    this.calls.sessionSwitchAgent.push(input);
    if (this.sessionSwitchAgentError) {
      throw this.sessionSwitchAgentError;
    }
  }

  async sessionSwitchModel(input: SessionSwitchModelInput): Promise<void> {
    this.calls.sessionSwitchModel.push(input);
    if (this.sessionSwitchModelError) {
      throw this.sessionSwitchModelError;
    }
  }

  async modelList(input: ModelListInput): Promise<ModelListOutput> {
    this.calls.modelList.push(input);
    if (this.modelListError) {
      throw this.modelListError;
    }
    if (this.modelListImplementation) {
      return await this.modelListImplementation(input);
    }
    return this.modelListResponse;
  }

  async agentList(input: AgentListInput): Promise<AgentListOutput> {
    this.calls.agentList.push(input);
    if (this.agentListError) {
      throw this.agentListError;
    }
    if (this.agentListImplementation) {
      return await this.agentListImplementation(input);
    }
    return this.agentListResponse;
  }

  async messageList(input: MessageListInput): Promise<SessionMessagesResponse> {
    this.calls.messageList.push(input);
    if (this.messageListError) {
      throw this.messageListError;
    }
    if (this.messageListImplementation) {
      return await this.messageListImplementation(input);
    }
    return this.messageListResponse;
  }

  async permissionReply(input: PermissionReplyInput): Promise<void> {
    this.calls.permissionReply.push(input);
    if (this.permissionReplyError) {
      throw this.permissionReplyError;
    }
  }

  async formReply(input: FormReplyInput): Promise<void> {
    this.calls.formReply.push(input);
    if (this.formReplyError) {
      throw this.formReplyError;
    }
  }

  async formCancel(input: FormCancelInput): Promise<void> {
    this.calls.formCancel.push(input);
    if (this.formCancelError) {
      throw this.formCancelError;
    }
  }

  event = {
    subscribe: (requestOptions?: { signal?: AbortSignal }) => {
      this.calls.eventSubscribe.push(requestOptions);
      return stopEventStreamOnAbort(this.queuedEventStream.stream, requestOptions?.signal);
    },
  };

  // Namespaced surface matching OpenCodeV2ClientLike. The provider code talks
  // to `client.session.create(...)` etc.; these delegate to the flat methods
  // above so the `calls` recorder keeps working.
  session = {
    create: (input: SessionCreateInput) => this.sessionCreate(input),
    prompt: (input: SessionPromptInput) => this.sessionPrompt(input),
    interrupt: (input: SessionInterruptInput) => this.sessionInterrupt(input),
    get: (input: SessionGetInput) => this.sessionGet(input),
    remove: (input: SessionRemoveInput) => this.sessionRemove(input),
    switchAgent: (input: SessionSwitchAgentInput) => this.sessionSwitchAgent(input),
    switchModel: (input: SessionSwitchModelInput) => this.sessionSwitchModel(input),
  };

  message = {
    list: (input: MessageListInput) => this.messageList(input),
  };

  model = {
    list: (input: ModelListInput) => this.modelList(input),
  };

  agent = {
    list: (input: AgentListInput) => this.agentList(input),
  };

  permission = {
    reply: (input: PermissionReplyInput) => this.permissionReply(input),
  };

  form = {
    reply: (input: FormReplyInput) => this.formReply(input),
    cancel: (input: FormCancelInput) => this.formCancel(input),
  };
}

function stopEventStreamOnAbort(
  stream: AsyncIterable<EventSubscribeOutput>,
  signal: AbortSignal | undefined,
): AsyncIterable<EventSubscribeOutput> {
  if (!signal) {
    return stream;
  }
  return {
    [Symbol.asyncIterator]: () => {
      const iterator = stream[Symbol.asyncIterator]();
      return {
        next: () => {
          if (signal.aborted) {
            return Promise.resolve({ done: true, value: undefined });
          }
          return new Promise<IteratorResult<EventSubscribeOutput>>((resolve, reject) => {
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

function createQueuedEventStream(): {
  stream: AsyncIterable<EventSubscribeOutput>;
  emit: (event: EventSubscribeOutput) => void;
} {
  const queue: EventSubscribeOutput[] = [];
  const waiters: Array<(result: IteratorResult<EventSubscribeOutput>) => void> = [];

  return {
    stream: {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          const event = queue.shift();
          if (event !== undefined) {
            return Promise.resolve({ done: false, value: event });
          }
          return new Promise<IteratorResult<EventSubscribeOutput>>((resolve) => {
            waiters.push(resolve);
          });
        },
      }),
    },
    emit: (event: EventSubscribeOutput) => {
      const waiter = waiters.shift();
      if (waiter) {
        waiter({ done: false, value: event });
        return;
      }
      queue.push(event);
    },
  };
}
