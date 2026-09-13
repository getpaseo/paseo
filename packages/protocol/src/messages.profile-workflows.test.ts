import { expect, test } from "vitest";
import {
  AgentProfileSchema,
  AgentSnapshotPayloadSchema,
  CreateAgentRequestMessageSchema,
  MutableDaemonConfigPatchSchema,
} from "./messages.js";

test("profiles round-trip optional post-approval modes with old and new schemas", () => {
  const old = AgentProfileSchema.omit({ postApprovalModeId: true });
  const legacy = { id: "planner", name: "Planner", provider: "codex" };
  expect(AgentProfileSchema.parse(legacy)).toEqual(legacy);
  const current = { ...legacy, postApprovalModeId: "auto" };
  expect(old.parse(current)).toEqual(current);
  expect(AgentProfileSchema.parse(old.parse(current))).toEqual(current);
  expect(MutableDaemonConfigPatchSchema.parse({})).toEqual({});
  expect(MutableDaemonConfigPatchSchema.parse({ addAgentProfilesIfMissing: [current] })).toEqual({
    addAgentProfilesIfMissing: [current],
  });
});

test("old and new snapshots keep optional historical approval and completion provenance compatible", () => {
  const current = AgentSnapshotPayloadSchema.pick({
    id: true,
    launchProfileId: true,
    launchPostApprovalModeId: true,
    lastCompletedTurnId: true,
  });
  const old = current.omit({ launchPostApprovalModeId: true, lastCompletedTurnId: true });
  const legacy = { id: "agent", launchProfileId: "planner" };
  expect(current.parse(legacy)).toEqual(legacy);
  const snapshot = { ...legacy, launchPostApprovalModeId: "auto", lastCompletedTurnId: "turn-2" };
  expect(current.parse(snapshot)).toEqual(snapshot);
  expect(old.parse(snapshot)).toEqual(legacy);
  expect(CreateAgentRequestMessageSchema.shape).not.toHaveProperty("launchPostApprovalModeId");
  expect(CreateAgentRequestMessageSchema.shape).not.toHaveProperty("lastCompletedTurnId");
});
