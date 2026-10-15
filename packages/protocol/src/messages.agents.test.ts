import { expect, test } from "vitest";
import {
  AgentConfigApplyRequestMessageSchema,
  CreateAgentRequestMessageSchema,
  UpdateAgentRequestMessageSchema,
} from "./messages.js";

test("launch provenance is creation-only and optional for older callers", () => {
  const request = {
    type: "create_agent_request",
    config: { provider: "codex", cwd: "/project" },
    requestId: "request",
  };
  expect(
    CreateAgentRequestMessageSchema.parse({ ...request, launchProfileId: "planner" }),
  ).toMatchObject({ launchProfileId: "planner" });
  expect(CreateAgentRequestMessageSchema.parse(request)).not.toHaveProperty("launchProfileId");
  expect(
    CreateAgentRequestMessageSchema.safeParse({ ...request, launchProfileId: 1 }).success,
  ).toBe(false);
  expect(
    UpdateAgentRequestMessageSchema.parse({
      type: "update_agent_request",
      agentId: "agent",
      requestId: "request",
      launchProfileId: "other",
    }),
  ).not.toHaveProperty("launchProfileId");
  const applied = AgentConfigApplyRequestMessageSchema.parse({
    type: "agent.config.apply.request",
    agentId: "agent",
    requestId: "request",
    launchProfileId: "other",
    config: { modelId: "gpt-5.4", launchProfileId: "other" },
  });
  expect(applied).not.toHaveProperty("launchProfileId");
  expect(applied.config).toEqual({ modelId: "gpt-5.4" });
});
