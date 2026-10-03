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

test("optional ordered routing preserves exact profile identity and bounded choices", () => {
  const routingPolicy = {
    strategy: "ordered",
    routes: [
      { provider: "codex-plus", model: "gpt-6-luna", thinkingOptionId: "low" },
      { provider: "codex-business", model: "gpt-6-luna" },
    ],
  };
  const request = {
    type: "create_agent_request",
    requestId: "ordered",
    config: { provider: "codex-plus", cwd: "/repo/app", routingPolicy },
  };
  expect(SessionInboundMessageSchema.parse(request)).toMatchObject({ config: { routingPolicy } });
  expect(
    SessionInboundMessageSchema.safeParse({
      ...request,
      config: { ...request.config, routingPolicy: { ...routingPolicy, routes: [] } },
    }).success,
  ).toBe(false);
  expect(
    SessionInboundMessageSchema.safeParse({
      ...request,
      config: {
        ...request.config,
        routingPolicy: {
          ...routingPolicy,
          routes: Array.from({ length: 17 }, () => routingPolicy.routes[0]),
        },
      },
    }).success,
  ).toBe(false);
});

test("ordered routing update accepts a policy or explicit clearing without changing legacy requests", () => {
  const request = {
    type: "agent.routing_policy.set.request",
    requestId: "update",
    agentId: "same-agent",
    routingPolicy: {
      strategy: "ordered",
      routes: [{ provider: "codex-plus", model: "gpt-6-luna" }],
    },
  };
  expect(SessionInboundMessageSchema.parse(request)).toEqual(request);
  expect(SessionInboundMessageSchema.parse({ ...request, routingPolicy: null })).toEqual({
    ...request,
    routingPolicy: null,
  });
});
