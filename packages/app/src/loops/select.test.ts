import { describe, expect, it } from "vitest";
import { selectLoopsForAgent } from "./select";

describe("selectLoopsForAgent", () => {
  const loops = [
    {
      id: "loop-worker",
      name: "Worker loop",
      status: "running",
      activeIteration: 2,
      activeWorkerAgentId: "agent-a",
      activeVerifierAgentId: "agent-b",
    },
    {
      id: "loop-verifier-only",
      name: "Verifier loop",
      status: "running",
      activeIteration: 1,
      activeWorkerAgentId: "agent-other",
      activeVerifierAgentId: "agent-a",
    },
    {
      id: "loop-stopped",
      name: "Stopped loop",
      status: "stopped",
      activeIteration: 3,
      activeWorkerAgentId: "agent-a",
      activeVerifierAgentId: "agent-a",
    },
    {
      id: "loop-unrelated",
      name: "Unrelated",
      status: "running",
      activeIteration: null,
      activeWorkerAgentId: "agent-x",
      activeVerifierAgentId: "agent-y",
    },
  ];

  it("returns worker role for running loop where agent is active worker", () => {
    const rows = selectLoopsForAgent({ agentId: "agent-a", loops });
    expect(rows).toContainEqual({
      loopId: "loop-worker",
      name: "Worker loop",
      promptPreview: null,
      role: "worker",
      activeIteration: 2,
      status: "running",
    });
  });

  it("returns verifier role for running loop where agent is active verifier", () => {
    const rows = selectLoopsForAgent({ agentId: "agent-a", loops });
    expect(rows).toContainEqual({
      loopId: "loop-verifier-only",
      name: "Verifier loop",
      promptPreview: null,
      role: "verifier",
      activeIteration: 1,
      status: "running",
    });
  });

  it("prefers worker when agent is both worker and verifier on same running loop", () => {
    const rows = selectLoopsForAgent({
      agentId: "agent-both",
      loops: [
        {
          id: "loop-both",
          name: "Both",
          status: "running",
          activeIteration: 4,
          activeWorkerAgentId: "agent-both",
          activeVerifierAgentId: "agent-both",
        },
      ],
    });
    expect(rows).toEqual([
      {
        loopId: "loop-both",
        name: "Both",
        promptPreview: null,
        role: "worker",
        activeIteration: 4,
        status: "running",
      },
    ]);
  });

  it("returns empty when agent is neither worker nor verifier", () => {
    const rows = selectLoopsForAgent({ agentId: "agent-z", loops });
    expect(rows).toEqual([]);
  });

  it("skips non-running loops even when agent matches worker or verifier", () => {
    const rows = selectLoopsForAgent({ agentId: "agent-a", loops });
    expect(rows.map((row) => row.loopId)).not.toContain("loop-stopped");
  });

  it("returns only matching running membership rows for agent-a", () => {
    const rows = selectLoopsForAgent({ agentId: "agent-a", loops });
    expect(rows.map((row) => ({ loopId: row.loopId, role: row.role }))).toEqual([
      { loopId: "loop-worker", role: "worker" },
      { loopId: "loop-verifier-only", role: "verifier" },
    ]);
  });
});
