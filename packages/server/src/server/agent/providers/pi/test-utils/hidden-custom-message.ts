import type { PiAgentMessage } from "../rpc-types.js";

// A pi-goal-x 0.31.9 (2e8ad767) checkpoint continuation, captured verbatim from a real
// `pi --mode rpc` run (Pi 0.84.4) on 2026-09-26. pi-goal-x sends it with `display: false`:
// the marker is for the model, and Pi's TUI never renders it.
export const HIDDEN_GOAL_CONTINUATION: PiAgentMessage = {
  role: "custom",
  customType: "pi-goal-event",
  content: '<pi_goal_continuation goal_id="muioeg51-6db1a7" kind="checkpoint" v="2"/>',
  display: false,
  details: {
    version: 3,
    generation: "13a8082c-e249-4df5-ac0e-fdc863ad289e",
    dispatchId: "a9c0ef02-d39c-42a2-8d5a-993a96b4e827",
    kind: "checkpoint",
    goalId: "muioeg51-6db1a7",
    status: "active",
    revision: 3,
    checkpointSeq: 1,
    timestamp: 1790444456255,
  },
  timestamp: 1790444456256,
};
