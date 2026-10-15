import { expect, test } from "vitest";
import {
  ServerInfoStatusPayloadSchema,
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
} from "./messages.js";

test("conditional plan revision is optional on old hosts and has a correlated dotted response", () => {
  expect(
    ServerInfoStatusPayloadSchema.parse({ status: "server_info", serverId: "old", features: {} })
      .features.conditionalPlanRevision,
  ).toBeUndefined();
  expect(
    ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "new",
      features: { conditionalPlanRevision: true },
    }).features.conditionalPlanRevision,
  ).toBe(true);
  expect(
    SessionInboundMessageSchema.parse({
      type: "agent.plan.revision.send.request",
      requestId: "rpc",
      agentId: "agent",
      workspaceId: "workspace",
      callId: "source",
      sourcePlanText: "Exact plan",
      text: "Revise",
      messageId: "revision",
    }),
  ).toMatchObject({ sourcePlanText: "Exact plan" });
  expect(
    SessionOutboundMessageSchema.parse({
      type: "agent.plan.revision.send.response",
      payload: { requestId: "rpc", accepted: false },
    }),
  ).toMatchObject({ payload: { accepted: false } });
});

test("plan review claims are a gated dotted RPC without changing old server info", () => {
  expect(
    ServerInfoStatusPayloadSchema.parse({ status: "server_info", serverId: "old", features: {} })
      .features.planReviewClaims,
  ).toBeUndefined();
  expect(
    ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "new",
      features: { planReviewClaims: true },
    }).features.planReviewClaims,
  ).toBe(true);
  expect(
    SessionInboundMessageSchema.parse({
      type: "agent.plan.review.claim.request",
      requestId: "rpc",
      agentId: "agent",
      workspaceId: "workspace",
      callId: "plan",
      permissionRequestId: "permission",
      active: true,
    }),
  ).toMatchObject({ active: true });
  expect(
    SessionOutboundMessageSchema.parse({
      type: "agent.plan.review.claim.response",
      payload: { requestId: "rpc", active: true },
    }),
  ).toMatchObject({ payload: { active: true } });
});

test("structured plan ensure keeps old hosts valid and accepts completed undecided proposals", () => {
  expect(
    ServerInfoStatusPayloadSchema.parse({ status: "server_info", serverId: "old", features: {} })
      .features.structuredPlanApproval,
  ).toBeUndefined();
  expect(
    ServerInfoStatusPayloadSchema.parse({
      status: "server_info",
      serverId: "new",
      features: { structuredPlanApproval: true },
    }).features.structuredPlanApproval,
  ).toBe(true);
  expect(
    SessionInboundMessageSchema.parse({
      type: "agent.plan.permission.ensure.request",
      requestId: "rpc",
      agentId: "agent",
      workspaceId: "workspace",
      callId: "plan",
    }),
  ).not.toHaveProperty("permissionRequestId");
  expect(
    SessionOutboundMessageSchema.parse({
      type: "agent.plan.permission.ensure.response",
      payload: {
        requestId: "rpc",
        permission: {
          id: "server-derived",
          provider: "codex",
          name: "plan_approval",
          kind: "plan",
          sourcePlanCallId: "plan",
          input: { plan: "Implement" },
        },
      },
    }),
  ).toMatchObject({ payload: { permission: { id: "server-derived" } } });
});
