import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import { describe, expect, it } from "vitest";
import { render } from "../../output/index.js";
import { runLsCommandWithDependencies, type PermitLsDependencies } from "./ls.js";

describe("permit ls output", () => {
  it("keeps the full request id in JSON while shortening the table column", async () => {
    const requestId = "permission-request-1234567890";
    const agent = {
      id: "agent-1234567890",
      pendingPermissions: [
        {
          id: requestId,
          name: "Bash",
          description: "Run a command",
        },
      ],
    } as AgentSnapshotPayload;
    const dependencies: PermitLsDependencies = {
      connectToDaemon: async () => ({
        fetchAgents: async () => ({
          entries: [{ agent }],
          nextCursor: undefined,
        }),
        close: async () => undefined,
      }),
    };

    const result = await runLsCommandWithDependencies(
      { daemonTarget: { kind: "endpoint", host: "example.test:12345" } },
      dependencies,
    );

    expect(JSON.parse(render(result, { format: "json" }))).toEqual([
      {
        id: requestId,
        agentId: "agent-1234567890",
        agentShortId: "agent-1",
        name: "Bash",
        description: "Run a command",
      },
    ]);
    expect(render(result, { format: "table", noColor: true })).toContain("permissi");
    expect(render(result, { format: "table", noColor: true })).not.toContain(requestId);
  });
});
