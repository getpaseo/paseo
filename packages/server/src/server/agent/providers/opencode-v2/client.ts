import {
  OpenCode,
  type EventSubscribeOutput,
  type FormCancelInput,
  type FormReplyInput,
  type MessageListInput,
  type PermissionReplyInput,
  type SessionCreateInput,
  type SessionGetInput,
  type SessionInfo,
  type SessionInterruptInput,
  type SessionInterruptResponse,
  type SessionInboxUser,
  type SessionMessagesResponse,
  type SessionPromptInput,
  type SessionRemoveInput,
} from "@opencode-ai/client";

/**
 * Thin client surface the opencode-v2 provider talks to. Kept deliberately
 * small and method-shaped so tests can inject a fake implementation (see
 * test-utils/test-opencode-v2-harness.ts) without touching the real
 * `@opencode-ai/client` network stack. All provider code goes through this
 * interface, never directly to the npm client.
 */
export interface OpenCodeV2ClientLike {
  session: {
    create(input: SessionCreateInput): Promise<SessionInfo>;
    prompt(input: SessionPromptInput): Promise<SessionInboxUser>;
    interrupt(input: SessionInterruptInput): Promise<SessionInterruptResponse>;
    get(input: SessionGetInput): Promise<SessionInfo>;
    remove(input: SessionRemoveInput): Promise<void>;
  };
  message: {
    list(input: MessageListInput): Promise<SessionMessagesResponse>;
  };
  permission: {
    reply(input: PermissionReplyInput): Promise<void>;
  };
  form: {
    reply(input: FormReplyInput): Promise<void>;
    cancel(input: FormCancelInput): Promise<void>;
  };
  event: {
    subscribe(requestOptions?: { signal?: AbortSignal }): AsyncIterable<EventSubscribeOutput>;
  };
}

export interface OpenCodeV2ClientOptions {
  baseUrl: string;
  authorization: string;
}

export type OpenCodeV2ClientFactory = (options: OpenCodeV2ClientOptions) => OpenCodeV2ClientLike;

/**
 * Real client factory. `OpenCode.make` is the v2 network client; it performs
 * HTTP Basic auth via the `authorization` header built by the server manager.
 */
export function createOpenCodeV2Client(options: OpenCodeV2ClientOptions): OpenCodeV2ClientLike {
  const client = OpenCode.make({
    baseUrl: options.baseUrl,
    headers: { authorization: options.authorization },
  });

  return {
    session: {
      create: (input) => client.session.create(input),
      prompt: (input) => client.session.prompt(input),
      interrupt: (input) => client.session.interrupt(input),
      get: (input) => client.session.get(input),
      remove: (input) => client.session.remove(input),
    },
    message: {
      list: (input) => client.message.list(input),
    },
    permission: {
      reply: (input) => client.permission.reply(input),
    },
    form: {
      reply: (input) => client.form.reply(input),
      cancel: (input) => client.form.cancel(input),
    },
    event: {
      subscribe: (requestOptions) => client.event.subscribe(requestOptions),
    },
  };
}
