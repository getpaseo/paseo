import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProviderSubagentInputEvent } from "../../../provider-subagents/store.js";
import { WorkflowAgentsThrottle } from "./workflow-agents-throttle.js";

function agentsUpsert(id: string, label: string): ProviderSubagentInputEvent {
  return {
    type: "upsert",
    id,
    workflowAgents: [{ status: "running", label, lastProgressAt: null }],
  };
}

describe("WorkflowAgentsThrottle", () => {
  let now = 0;
  let sent: ProviderSubagentInputEvent[];
  let throttle: WorkflowAgentsThrottle;

  beforeEach(() => {
    vi.useFakeTimers();
    now = 0;
    sent = [];
    throttle = new WorkflowAgentsThrottle({
      intervalMs: 500,
      send: (event) => sent.push(event),
      now: () => now,
    });
  });

  afterEach(() => {
    throttle.dispose();
    vi.useRealTimers();
  });

  it("sends the first list at once and holds only the newest of a burst", () => {
    expect(throttle.route([agentsUpsert("wf", "a")])).toEqual([agentsUpsert("wf", "a")]);
    expect(throttle.route([agentsUpsert("wf", "b")])).toEqual([]);
    expect(throttle.route([agentsUpsert("wf", "c")])).toEqual([]);

    now = 500;
    vi.advanceTimersByTime(500);
    expect(sent).toEqual([agentsUpsert("wf", "c")]);
  });

  it("paces each subagent on its own clock", () => {
    throttle.route([agentsUpsert("one", "a")]);

    expect(throttle.route([agentsUpsert("two", "a")])).toEqual([agentsUpsert("two", "a")]);
  });

  it("sends a held list before any other event for the same subagent", () => {
    throttle.route([agentsUpsert("wf", "a")]);
    throttle.route([agentsUpsert("wf", "b")]);
    const status: ProviderSubagentInputEvent = { type: "upsert", id: "wf", status: "completed" };

    expect(throttle.route([status])).toEqual([agentsUpsert("wf", "b"), status]);
    vi.advanceTimersByTime(1000);
    expect(sent).toEqual([]);
  });

  it("drops held lists when disposed", () => {
    throttle.route([agentsUpsert("wf", "a")]);
    throttle.route([agentsUpsert("wf", "b")]);
    throttle.dispose();

    vi.advanceTimersByTime(1000);
    expect(sent).toEqual([]);
  });
});
