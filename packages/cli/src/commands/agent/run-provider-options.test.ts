import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const agent = {
    id: "00000000-0000-4000-8000-000000000001",
    provider: "codex",
    cwd: "/workspace",
    title: null,
    status: "idle",
  };
  return {
    agent,
    createAgent: vi.fn(async () => agent),
    createWorkspace: vi.fn(async () => ({
      workspace: {
        id: "workspace-1",
        name: "workspace",
        workspaceDirectory: "/workspace",
      },
    })),
    waitForFinish: vi.fn(async () => ({
      status: "idle",
      final: agent,
      lastMessage: '{"summary":"ok"}',
    })),
    close: vi.fn(async () => undefined),
  };
});

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(async () => mocks),
  getDaemonHost: vi.fn(() => "localhost:6767"),
}));

vi.mock("@getpaseo/server", () => ({
  StructuredAgentResponseError: class StructuredAgentResponseError extends Error {},
  getStructuredAgentResponse: vi.fn(
    async ({ caller, prompt }: { caller: (value: string) => Promise<string>; prompt: string }) => {
      await caller(prompt);
      return { summary: "ok" };
    },
  ),
}));

import { runRunCommand } from "./run.js";

const providerOptions = {
  approval_policy: "never",
  sandbox_mode: "workspace-write",
  sandbox_workspace_write: {
    network_access: false,
    exclude_slash_tmp: true,
    exclude_tmpdir_env_var: true,
  },
};

describe("run provider option propagation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("forwards the exact object on a normal run", async () => {
    await runRunCommand(
      "bounded task",
      {
        provider: "codex",
        model: "gpt-5.4",
        background: true,
        providerOptions: JSON.stringify(providerOptions),
      },
      {} as never,
    );

    expect(mocks.createAgent).toHaveBeenCalledOnce();
    expect(mocks.createAgent).toHaveBeenCalledWith(expect.objectContaining({ providerOptions }));
  });

  it("forwards the exact object on a structured run", async () => {
    await runRunCommand(
      "bounded task",
      {
        provider: "codex",
        model: "gpt-5.4",
        providerOptions: JSON.stringify(providerOptions),
        outputSchema: '{"type":"object"}',
      },
      {} as never,
    );

    expect(mocks.createAgent).toHaveBeenCalledOnce();
    expect(mocks.createAgent).toHaveBeenCalledWith(expect.objectContaining({ providerOptions }));
  });
});
