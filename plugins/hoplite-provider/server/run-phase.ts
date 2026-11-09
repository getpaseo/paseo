import type { AcpTransformer } from "@getpaseo/plugin/server/acp";
import { z } from "zod";

// Hoplite provisions a cloud workspace before the first agent output of a run and reports each
// step as `_hoplite/run_phase`. A null phase ends provisioning for that run.
const runPhaseSchema = z.object({
  runId: z.string().min(1),
  phase: z.string().nullable(),
  label: z.string().nullable(),
});

const RUN_PHASE_METHOD = "_hoplite/run_phase";

export const runPhaseTransformer: AcpTransformer = {
  notification(notification) {
    if (notification.method !== RUN_PHASE_METHOD) return null;
    const params = runPhaseSchema.safeParse(notification.params);
    if (!params.success) return null;
    const { runId, phase, label } = params.data;
    const id = `hoplite-run-phase:${runId}`;
    const running = phase !== null;
    return {
      type: "timeline",
      item: {
        type: "tool_call",
        id,
        callId: id,
        name: "Hoplite workspace",
        detail: {
          type: "plain_text",
          label: running ? (label ?? phase) : "Workspace ready",
          icon: "wrench",
        },
        status: running ? "running" : "completed",
        error: null,
      },
    };
  },
};
