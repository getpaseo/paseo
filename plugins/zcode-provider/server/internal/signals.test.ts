import { describe, expect, test } from "vitest";
import { mapPermissionRequest, permissionResponseFor } from "./signals.js";

describe("ZCode permission mapping", () => {
  const payload = {
    requestId: "p1",
    sessionId: "s1",
    toolCallId: "t1",
    toolName: "bash",
    reason: "run a command",
    riskLevel: "medium",
    input: { command: "ls" },
    options: [
      {
        optionId: "allow-once",
        kind: "allow",
        name: "Allow once",
        response: { decision: "allow" },
      },
      {
        optionId: "always",
        kind: "allow",
        name: "Always allow",
        response: {
          decision: "allow",
          permissionUpdates: { addRules: [{ behavior: "allow", toolName: "bash" }] },
        },
      },
      {
        optionId: "deny",
        kind: "deny",
        name: "Deny",
        response: { decision: "deny", reason: "not allowed" },
      },
    ],
  };

  test("maps the options to permission actions", () => {
    const request = mapPermissionRequest(payload);
    expect(request.id).toBe("p1");
    expect(request.name).toBe("bash");
    expect(request.kind).toBe("tool");
    expect(request.actions?.map((action) => action.id)).toEqual(["allow-once", "always", "deny"]);
    expect(request.actions?.map((action) => action.behavior)).toEqual(["allow", "allow", "deny"]);
  });

  test("returns the selected option's ZCode response unchanged", () => {
    const request = mapPermissionRequest(payload);
    expect(
      permissionResponseFor(request, { behavior: "allow", selectedActionId: "always" }),
    ).toEqual({
      decision: "allow",
      permissionUpdates: { addRules: [{ behavior: "allow", toolName: "bash" }] },
    });
  });

  test("rejects an unknown action id", () => {
    const request = mapPermissionRequest(payload);
    expect(() =>
      permissionResponseFor(request, { behavior: "allow", selectedActionId: "nope" }),
    ).toThrow(/nope/);
  });
});
