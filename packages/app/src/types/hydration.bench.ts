import { bench, describe } from "vitest";
import { hydrateStreamState } from "./stream";
import type { AgentStreamEventPayload } from "@getpaseo/protocol/messages";

for (const count of [1_000, 5_000, 10_000]) {
  const events = Array.from({ length: count }, (_, index) => ({
    event: {
      type: "timeline",
      provider: "claude",
      turnId: "large-turn",
      item: {
        type: "tool_call",
        callId: `call-${index}`,
        name: "shell",
        status: "completed",
        error: null,
        detail: { type: "shell", command: `echo ${index}` },
      },
    } as AgentStreamEventPayload,
    timestamp: new Date(1700000000000 + index),
  }));
  describe(`${count} tool calls in a history snapshot`, () => {
    bench(
      "hydrate",
      () => {
        hydrateStreamState(events);
      },
      { time: 300, iterations: 2, warmupTime: 0, warmupIterations: 1 },
    );
  });
}
