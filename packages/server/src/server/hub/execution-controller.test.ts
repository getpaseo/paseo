import { describe, expect, test } from "vitest";
import type {
  AgentSnapshotPayload,
  HubExecutionAgentCreateRequest,
  SessionOutboundMessage,
} from "@getpaseo/protocol/messages";

import type {
  HubExecutionAgents,
  OwnedAgentEvent,
  OwnedAgentSnapshot,
} from "./daemon-executions.js";
import { HubExecutionController } from "./execution-controller.js";

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
});
