import { describe, expect, it } from "vitest";
import { WorkspaceGitWorkflowConfigSchema } from "@getpaseo/protocol/workspace-config";
import type { WSOutboundMessage } from "./messages.js";
import { workspaceConflictModelMessage } from "./workspace-conflict-model-compat.js";

const config = {
  workspaceGitWorkflow: {
    prModel: { provider: "codex", model: "pr" },
    conflictModel: { provider: "codex", model: "conflicts", thinkingOptionId: "high" },
  },
};
describe("conflict model wire compatibility", () => {
  it.each(["get_daemon_config_response", "set_daemon_config_response", "status"] as const)(
    "adapts %s per client without changing stored config",
    (type) => {
      const message = {
        type: "session",
        message: {
          type,
          payload: { requestId: "request", status: "daemon_config_changed", config },
        },
      } as WSOutboundMessage;
      expect(workspaceConflictModelMessage(message, true)).toBe(message);
      const legacy = workspaceConflictModelMessage(message, false);
      expect(legacy).toEqual({
        type: "session",
        message: {
          type,
          payload: {
            requestId: "request",
            status: "daemon_config_changed",
            config: { workspaceGitWorkflow: { prModel: config.workspaceGitWorkflow.prModel } },
          },
        },
      });
      const oldSchema = WorkspaceGitWorkflowConfigSchema.omit({ conflictModel: true });
      expect(oldSchema.safeParse(config.workspaceGitWorkflow).success).toBe(false);
      expect(config.workspaceGitWorkflow.conflictModel.thinkingOptionId).toBe("high");
      if (legacy.type !== "session" || !("config" in legacy.message.payload))
        throw new Error("Expected config");
      expect(oldSchema.safeParse(legacy.message.payload.config?.workspaceGitWorkflow).success).toBe(
        true,
      );
    },
  );
});
