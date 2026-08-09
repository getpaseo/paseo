import { describe, expect, test } from "vitest";
import type {
  AgentSnapshotPayload,
  HubExecutionAgentCreateRequest,
  SessionOutboundMessage,
} from "@getpaseo/protocol/messages";

import type {
  HubExecutionAgentCreateInput,
  HubExecutionAgents,
  OwnedAgentEvent,
  OwnedAgentSnapshot,
} from "./daemon-executions.js";
import { HubExecutionController } from "./execution-controller.js";
import {
  ProviderOptionsValidationError,
  ToolPolicyUnsupportedError,
} from "../agent/provider-options.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

class ControlledHubExecutionAgents implements HubExecutionAgents {
  private readonly createObserved = deferred<void>();
  private readonly createGate = deferred<OwnedAgentSnapshot>();
  lastCreateInput: HubExecutionAgentCreateInput | null = null;

  constructor(
    private readonly appliedOverride?: {
      providerOptionsApplied?: boolean;
      toolPolicyApplied?: boolean;
    },
  ) {}

  create(input: HubExecutionAgentCreateInput): Promise<OwnedAgentSnapshot> {
    this.lastCreateInput = input;
    this.createObserved.resolve();
    return this.createGate.promise;
  }

  async control(): Promise<void> {}

  subscribe(_listener: (event: OwnedAgentEvent) => void): () => void {
    return () => undefined;
  }

  async invalidateAuthority(): Promise<void> {}

  async creationStarted(): Promise<void> {
    await this.createObserved.promise;
  }

  finishCreate(): void {
    this.createGate.resolve({
      executionId: "execution-shutdown",
      agent: {
        id: "agent-shutdown",
        status: "running",
      } as AgentSnapshotPayload,
      providerOptionsApplied:
        this.appliedOverride?.providerOptionsApplied ??
        this.lastCreateInput?.providerOptions !== undefined,
      toolPolicyApplied:
        this.appliedOverride?.toolPolicyApplied ?? this.lastCreateInput?.toolPolicy !== undefined,
    });
  }
}

class RejectingHubExecutionAgents implements HubExecutionAgents {
  constructor(private readonly error: Error) {}

  async create(): Promise<OwnedAgentSnapshot> {
    throw this.error;
  }

  async control(): Promise<void> {}

  subscribe(_listener: (event: OwnedAgentEvent) => void): () => void {
    return () => undefined;
  }

  async invalidateAuthority(): Promise<void> {}
}

describe("HubExecutionController", () => {
  test("cleanup fences in-flight creates before the dead session can receive a response", async () => {
    const agents = new ControlledHubExecutionAgents();
    const messages: SessionOutboundMessage[] = [];
    const controller = new HubExecutionController({
      agents,
      send: (message) => messages.push(message),
    });

    const create = controller.createAgent({
      type: "hub.execution.agent.create.request",
      requestId: "shutdown-create",
      executionId: "execution-shutdown",
      provider: "codex",
      cwd: "/tmp/paseo",
      prompt: "sleep 30",
    } satisfies HubExecutionAgentCreateRequest);
    await agents.creationStarted();

    const cleanup = controller.cleanup();
    agents.finishCreate();
    await Promise.all([create, cleanup]);

    expect(messages).toEqual([]);
  });

  test("acknowledges successful application of a requested tool policy", async () => {
    const agents = new ControlledHubExecutionAgents();
    const messages: SessionOutboundMessage[] = [];
    const controller = new HubExecutionController({
      agents,
      send: (message) => messages.push(message),
    });

    const create = controller.createAgent({
      type: "hub.execution.agent.create.request",
      requestId: "tool-policy-create",
      executionId: "execution-shutdown",
      provider: "hub-e2e",
      cwd: "/tmp/paseo",
      prompt: "finish",
      mcpServers: { hub: { type: "http", url: "http://127.0.0.1/execution" } },
      toolPolicy: {
        preapproved: [{ kind: "mcp", server: "hub", tool: "finish_execution" }],
      },
    });
    await agents.creationStarted();
    agents.finishCreate();
    await create;

    expect(messages).toEqual([
      expect.objectContaining({
        type: "hub.execution.agent.create.response",
        payload: expect.objectContaining({
          success: true,
          toolPolicyApplied: true,
        }),
      }),
    ]);
  });

  test("forwards exact v2 provider options and acknowledges their application", async () => {
    const agents = new ControlledHubExecutionAgents();
    const messages: SessionOutboundMessage[] = [];
    const controller = new HubExecutionController({
      agents,
      send: (message) => messages.push(message),
    });
    const providerOptions = {
      sandbox_mode: "workspace-write",
      sandbox_workspace_write: { network_access: false, writable_roots: [] },
    };

    const create = controller.createAgent({
      type: "hub.execution.agent.create.v2.request",
      requestId: "provider-options-create",
      executionId: "execution-shutdown",
      provider: "codex",
      cwd: "/tmp/paseo",
      prompt: "finish",
      providerOptions,
    });
    await agents.creationStarted();
    expect(agents.lastCreateInput?.providerOptions).toEqual(providerOptions);
    agents.finishCreate();
    await create;

    expect(messages).toEqual([
      expect.objectContaining({
        type: "hub.execution.agent.create.v2.response",
        payload: expect.objectContaining({
          success: true,
          providerOptionsApplied: true,
        }),
      }),
    ]);
  });

  test("does not acknowledge a v2 create when applied state is unverified", async () => {
    const agents = new ControlledHubExecutionAgents({ providerOptionsApplied: false });
    const messages: SessionOutboundMessage[] = [];
    const controller = new HubExecutionController({
      agents,
      send: (message) => messages.push(message),
    });

    const create = controller.createAgent({
      type: "hub.execution.agent.create.v2.request",
      requestId: "unverified-provider-options",
      executionId: "execution-shutdown",
      provider: "codex",
      cwd: "/tmp/paseo",
      prompt: "finish",
      providerOptions: { sandbox_mode: "workspace-write" },
    });
    await agents.creationStarted();
    agents.finishCreate();
    await create;

    expect(messages).toEqual([
      expect.objectContaining({
        type: "hub.execution.agent.create.v2.response",
        payload: expect.objectContaining({
          success: false,
          error: expect.objectContaining({
            message: expect.stringContaining("were not applied"),
          }),
        }),
      }),
    ]);
  });

  test.each([
    {
      error: new ProviderOptionsValidationError("codex", [
        { path: ["sandbox_workspace_write", "writable_roots", 0], message: "Expected string" },
      ]),
      expected: {
        code: "provider_options_invalid",
        provider: "codex",
        issues: [
          {
            path: ["sandbox_workspace_write", "writable_roots", 0],
            message: "Expected string",
          },
        ],
      },
    },
    {
      error: new ToolPolicyUnsupportedError("pi"),
      expected: { code: "tool_policy_unsupported", provider: "pi" },
    },
  ])("returns structured $expected.code create feedback", async ({ error, expected }) => {
    const messages: SessionOutboundMessage[] = [];
    const controller = new HubExecutionController({
      agents: new RejectingHubExecutionAgents(error),
      send: (message) => messages.push(message),
    });

    await controller.createAgent({
      type: "hub.execution.agent.create.request",
      requestId: "rejected-create",
      executionId: "rejected-execution",
      provider: "codex",
      cwd: "/tmp/paseo",
      prompt: "run unattended",
    });

    expect(messages).toEqual([
      expect.objectContaining({
        type: "hub.execution.agent.create.response",
        payload: expect.objectContaining({
          success: false,
          error: expect.objectContaining(expected),
        }),
      }),
    ]);
  });
});
