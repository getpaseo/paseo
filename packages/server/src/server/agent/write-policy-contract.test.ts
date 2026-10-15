import { expect, test } from "vitest";
import {
  CreateAgentRequestMessageSchema,
  ResumeAgentRequestMessageSchema,
} from "../../../../protocol/src/messages.js";
import { parseStoredAgentRecord } from "./agent-storage.js";
import { createAgentCommand, type CreateAgentCommandDependencies } from "./create-agent/create.js";
import { buildSessionConfig } from "../persistence-hooks.js";

test("writePolicy survives creation and persistence but is absent from resume overrides", () => {
  const config = { provider: "codex", cwd: "/workspace", writePolicy: "read_only" };
  expect(
    CreateAgentRequestMessageSchema.parse({
      type: "create_agent_request",
      requestId: "create",
      config,
    }).config,
  ).toMatchObject(config);
  expect(
    parseStoredAgentRecord({
      id: "agent",
      provider: "codex",
      cwd: "/workspace",
      createdAt: "2026-09-13T00:00:00.000Z",
      updatedAt: "2026-09-13T00:00:00.000Z",
      config: { writePolicy: "read_only" },
    }).config,
  ).toMatchObject({ writePolicy: "read_only" });
  const resume = ResumeAgentRequestMessageSchema.parse({
    type: "resume_agent_request",
    requestId: "resume",
    handle: { provider: "codex", sessionId: "thread" },
    overrides: { writePolicy: "read_write" },
  });
  expect(resume.overrides).not.toHaveProperty("writePolicy");
});

test("daemon restoration preserves the stored policy in session config", () => {
  const record = parseStoredAgentRecord({
    id: "agent",
    provider: "codex",
    cwd: "/workspace",
    createdAt: "2026-09-13T00:00:00.000Z",
    updatedAt: "2026-09-13T00:00:00.000Z",
    config: { writePolicy: "read_only" },
  });
  expect(buildSessionConfig(record)).toMatchObject({ writePolicy: "read_only" });
});

test("unsupported read-only creation rejects before workspace and provider resolution", async () => {
  await expect(
    createAgentCommand({} as CreateAgentCommandDependencies, {
      kind: "mcp",
      provider: "omp/test",
      title: "test",
      writePolicy: "read_only",
      background: true,
      notifyOnFinish: false,
    }),
  ).rejects.toMatchObject({ code: "write_policy_unsupported", provider: "omp" });
});
