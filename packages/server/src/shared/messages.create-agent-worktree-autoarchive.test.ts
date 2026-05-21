import { describe, expect, test } from "vitest";

import { SessionInboundMessageSchema } from "./messages.js";

describe("create_agent_request worktree and autoArchive fields", () => {
  test("accepts optional worktree branch-off target and autoArchive", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "create_agent_request",
      requestId: "create-agent-worktree",
      config: {
        provider: "codex",
        cwd: "/repo/app",
      },
      worktree: {
        mode: "branch-off",
        newBranch: "agent-lifecycle-dispatch",
        base: "main",
        gitConfig: {
          userName: "paseo-ai[bot]",
          userEmail: "123456+paseo-ai[bot]@users.noreply.github.com",
          remoteUrl: "https://x-access-token:ghs_install_token@github.com/boudra/faro.git",
        },
      },
      autoArchive: true,
    });

    expect(parsed).toEqual({
      type: "create_agent_request",
      requestId: "create-agent-worktree",
      config: {
        provider: "codex",
        cwd: "/repo/app",
      },
      worktree: {
        mode: "branch-off",
        newBranch: "agent-lifecycle-dispatch",
        base: "main",
        gitConfig: {
          userName: "paseo-ai[bot]",
          userEmail: "123456+paseo-ai[bot]@users.noreply.github.com",
          remoteUrl: "https://x-access-token:ghs_install_token@github.com/boudra/faro.git",
        },
      },
      autoArchive: true,
      labels: {},
    });
  });

  test("keeps legacy create_agent_request defaults unchanged", () => {
    const parsed = SessionInboundMessageSchema.parse({
      type: "create_agent_request",
      requestId: "legacy-create-agent",
      config: {
        provider: "codex",
        cwd: "/repo/app",
      },
    });

    expect(parsed).toEqual({
      type: "create_agent_request",
      requestId: "legacy-create-agent",
      config: {
        provider: "codex",
        cwd: "/repo/app",
      },
      labels: {},
    });
  });
});
