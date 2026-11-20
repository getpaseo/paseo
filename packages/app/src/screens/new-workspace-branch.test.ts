import { describe, expect, it } from "vitest";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";
import type { MessagePayload } from "@/composer/types";
import type { normalizeWorkspaceDescriptor } from "@/stores/session-store";
import { buildBranchedWorkspacePrompt, runCreateBranchedWorkspace } from "./new-workspace-branch";

type Workspace = ReturnType<typeof normalizeWorkspaceDescriptor>;

const branch = {
  sourceAgentId: "source-agent",
  sourceCwd: "/sample/repo",
  boundaryMessageId: "msg_turn_end",
};

function payload(text: string): MessagePayload {
  return { text, attachments: [], cwd: "/sample/repo" };
}

function createHarness() {
  const calls: string[] = [];
  const forks: Array<{ agentId: string; options: unknown }> = [];
  const messages: Array<{ agentId: string; text: string }> = [];
  const navigations: Array<{ serverId: string; workspaceId: string; agentId: string }> = [];
  const workspace = { id: "workspace-new", workspaceDirectory: "/sample/worktrees/new" };
  return {
    forks,
    messages,
    navigations,
    calls,
    ensureWorkspace: async (request: { withInitialAgent: boolean }) => {
      calls.push(`workspace:${request.withInitialAgent}`);
      return workspace as Workspace;
    },
    client: {
      forkAgent: async (agentId: string, options: unknown) => {
        calls.push("fork");
        forks.push({ agentId, options });
        return { id: "branched-agent" } as AgentSnapshotPayload;
      },
      sendAgentMessage: async (agentId: string, text: string) => {
        calls.push("message");
        messages.push({ agentId, text });
        return {};
      },
    },
    navigate: (serverId: string, workspaceId: string, agentId: string) => {
      calls.push("navigate");
      navigations.push({ serverId, workspaceId, agentId });
    },
  };
}

describe("runCreateBranchedWorkspace", () => {
  it("branches the source agent into the new checkout and sends the prompt with a notice", async () => {
    const harness = createHarness();

    await runCreateBranchedWorkspace({
      payload: payload("Run the tests here."),
      branch,
      ensureWorkspace: harness.ensureWorkspace,
      client: harness.client,
      serverId: "server-abc",
      navigate: harness.navigate,
    });

    expect(harness.calls).toEqual(["workspace:false", "fork", "message", "navigate"]);
    expect(harness.forks).toEqual([
      {
        agentId: "source-agent",
        options: {
          boundaryMessageId: "msg_turn_end",
          cwd: "/sample/worktrees/new",
          workspaceId: "workspace-new",
        },
      },
    ]);
    expect(harness.messages).toEqual([
      {
        agentId: "branched-agent",
        text: buildBranchedWorkspacePrompt({
          sourceCwd: "/sample/repo",
          cwd: "/sample/worktrees/new",
          text: "Run the tests here.",
        }),
      },
    ]);
    expect(harness.navigations).toEqual([
      { serverId: "server-abc", workspaceId: "workspace-new", agentId: "branched-agent" },
    ]);
  });

  it("opens the branch without sending anything when the prompt is empty", async () => {
    const harness = createHarness();

    await runCreateBranchedWorkspace({
      payload: payload("  "),
      branch,
      ensureWorkspace: harness.ensureWorkspace,
      client: harness.client,
      serverId: "server-abc",
      navigate: harness.navigate,
    });

    expect(harness.calls).toEqual(["workspace:false", "fork", "navigate"]);
  });
});

describe("buildBranchedWorkspacePrompt", () => {
  it("names both checkouts before the user's text", () => {
    const prompt = buildBranchedWorkspacePrompt({
      sourceCwd: "/sample/repo",
      cwd: "/sample/worktrees/new",
      text: "Continue.",
    });

    expect(prompt).toContain("`/sample/repo`");
    expect(prompt).toContain("`/sample/worktrees/new`");
    expect(prompt.endsWith("\n\nContinue.")).toBe(true);
  });
});
