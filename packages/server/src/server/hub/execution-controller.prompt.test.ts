import { describe, expect, test } from "vitest";
import type {
  HubExecutionAgentPromptRequest,
  SessionOutboundMessage,
} from "@getpaseo/protocol/messages";

import type {
  HubExecutionAgents,
  HubExecutionPromptInput,
  HubExecutionPromptResult,
  OwnedAgentEvent,
  OwnedAgentSnapshot,
} from "./daemon-executions.js";
import { HubExecutionController } from "./execution-controller.js";

class RecordingAgents implements HubExecutionAgents {
  readonly prompts: HubExecutionPromptInput[] = [];

  constructor(private readonly result: HubExecutionPromptResult | Error) {}

  async create(): Promise<OwnedAgentSnapshot> {
    throw new Error("not used");
  }

  async control(): Promise<void> {}

  async prompt(input: HubExecutionPromptInput): Promise<HubExecutionPromptResult> {
    this.prompts.push(input);
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }

  subscribe(_listener: (event: OwnedAgentEvent) => void): () => void {
    return () => undefined;
  }

  async invalidateAuthority(): Promise<void> {}
}

function controllerFor(agents: HubExecutionAgents): {
  controller: HubExecutionController;
  sent: SessionOutboundMessage[];
} {
  const sent: SessionOutboundMessage[] = [];
  const controller = new HubExecutionController({
    agents,
    validateAgentConfiguration: async () => [],
    send: (message) => sent.push(message),
  });
  return { controller, sent };
}

function request(overrides: Partial<HubExecutionAgentPromptRequest> = {}) {
  return {
    type: "hub.execution.agent.prompt.request",
    requestId: "request-1",
    executionId: "execution-1",
    prompt: "and now fix the loader",
    activeTurnBehavior: "steer",
    ...overrides,
  } as HubExecutionAgentPromptRequest;
}

describe("Hub execution prompt", () => {
  test("forwards the message to the live agent and reports how it was dispatched", async () => {
    const agents = new RecordingAgents({ delivered: true, disposition: "steered" });
    const { controller, sent } = controllerFor(agents);

    await controller.promptAgent(request());

    expect(agents.prompts).toEqual([
      { executionId: "execution-1", prompt: "and now fix the loader", activeTurnBehavior: "steer" },
    ]);
    expect(sent).toEqual([
      {
        type: "hub.execution.agent.prompt.response",
        payload: {
          requestId: "request-1",
          executionId: "execution-1",
          delivered: true,
          disposition: "steered",
          error: null,
        },
      },
    ]);
  });

  test("reports an execution with no live agent as undelivered, not as an error", async () => {
    const { controller, sent } = controllerFor(
      new RecordingAgents({ delivered: false, disposition: null }),
    );

    await controller.promptAgent(request());

    expect(sent[0]).toMatchObject({
      payload: { delivered: false, disposition: null, error: null },
    });
  });

  test("answers a blank prompt with an error instead of waking the agent", async () => {
    const agents = new RecordingAgents({ delivered: true, disposition: "steered" });
    const { controller, sent } = controllerFor(agents);

    await controller.promptAgent(request({ prompt: "   " }));

    expect(agents.prompts).toEqual([]);
    expect(sent[0]).toMatchObject({
      payload: { delivered: false, error: "Hub agent prompt cannot be blank" },
    });
  });

  test("reports a daemon failure without dropping the response", async () => {
    const { controller, sent } = controllerFor(new RecordingAgents(new Error("agent is loading")));

    await controller.promptAgent(request());

    expect(sent[0]).toMatchObject({
      payload: { delivered: false, disposition: null, error: "agent is loading" },
    });
  });

  test("stays silent once cleaned up", async () => {
    const { controller, sent } = controllerFor(
      new RecordingAgents({ delivered: true, disposition: "steered" }),
    );
    await controller.cleanup();

    await controller.promptAgent(request());

    expect(sent).toEqual([]);
  });
});
