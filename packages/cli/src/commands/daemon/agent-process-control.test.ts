import { describe, expect, test } from "vitest";
import { rejectAgentProcessControl } from "./agent-process-control.js";

describe("rejectAgentProcessControl", () => {
  test("allows daemon process control outside a managed agent", () => {
    expect(() => rejectAgentProcessControl("stop", {})).not.toThrow();
    expect(() => rejectAgentProcessControl("restart", { PASEO_AGENT_ID: "  " })).not.toThrow();
  });

  test.each(["stop", "restart"] as const)(
    "rejects daemon %s from a managed agent and directs it to supervised restart",
    (action) => {
      expect(() => rejectAgentProcessControl(action, { PASEO_AGENT_ID: "agent-1" })).toThrow(
        expect.objectContaining({
          code: "UNSAFE_AGENT_DAEMON_PROCESS_CONTROL",
          message: `A managed Paseo agent cannot run 'paseo daemon ${action}' safely.`,
          details:
            "Use the restart_daemon Paseo tool. The supervisor will restart the worker and monitor its heartbeat.",
        }),
      );
    },
  );
});
