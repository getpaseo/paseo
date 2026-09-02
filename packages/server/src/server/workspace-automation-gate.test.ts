import { describe, expect, it } from "vitest";
import {
  WorkspaceAutomationBlockedError,
  assertWorkspaceAutomationAllowed,
} from "./workspace-automation-gate.js";

describe("workspace automation gate", () => {
  it("refuses executable repository automation for a cross-repository change request", () => {
    expect(() =>
      assertWorkspaceAutomationAllowed({
        kind: "change_request",
        forge: "github",
        number: 42,
        headRepository: "contributor/paseo",
      }),
    ).toThrowError(
      new WorkspaceAutomationBlockedError({
        kind: "change_request",
        forge: "github",
        number: 42,
        headRepository: "contributor/paseo",
      }),
    );
  });

  it("allows executable repository automation for ordinary workspaces", () => {
    expect(() => assertWorkspaceAutomationAllowed(undefined)).not.toThrow();
  });
});
