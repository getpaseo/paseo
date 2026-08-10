import { describe, expect, test } from "vitest";
import type {
  AgentSnapshotPayload,
  HubExecutionAgentCreateRequest,
  HubExecutionAgentValidateRequest,
  SessionOutboundMessage,
} from "@getpaseo/protocol/messages";

import type {
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

  create(): Promise<OwnedAgentSnapshot> {
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
  test("validates a named agent through the daemon provider registry", async () => {
    const messages: SessionOutboundMessage[] = [];
    const validateAgentConfiguration = async (
      message: Omit<HubExecutionAgentValidateRequest, "type" | "requestId">,
    ) =>
      message.model === "missing" ? [{ path: ["model"], message: "Model is unavailable" }] : [];
    const controller = new HubExecutionController({
      agents: new ControlledHubExecutionAgents(),
      validateAgentConfiguration,
      send: (message) => messages.push(message),
    });

    await controller.validateAgent({
      type: "hub.execution.agent.validate.request",
      requestId: "validate-agent",
      provider: "codex",
      model: "missing",
    });

    expect(messages).toEqual([
      {
        type: "hub.execution.agent.validate.response",
        payload: {
          requestId: "validate-agent",
          valid: false,
          issues: [{ path: ["model"], message: "Model is unavailable" }],
          error: null,
        },
      },
    ]);
  });

  test("cleanup fences in-flight creates before the dead session can receive a response", async () => {
    const agents = new ControlledHubExecutionAgents();
    const messages: SessionOutboundMessage[] = [];
    const controller = new HubExecutionController({
      agents,
      validateAgentConfiguration: async () => [],
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
      validateAgentConfiguration: async () => [],
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
      validateAgentConfiguration: async () => [],
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
