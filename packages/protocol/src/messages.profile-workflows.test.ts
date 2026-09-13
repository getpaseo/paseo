import { expect, test } from "vitest";
import { AgentProfileSchema, MutableDaemonConfigPatchSchema } from "./messages.js";

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
