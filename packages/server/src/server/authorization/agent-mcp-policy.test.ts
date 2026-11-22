import { describe, expect, test } from "vitest";

import { OWNER_PRINCIPAL } from "../auth.js";
import { mergePaseoToolPolicies, resolveAgentMcpAccess } from "./agent-mcp-policy.js";

describe("agent MCP access", () => {
  test("gives the owner unrestricted access", () => {
    expect(resolveAgentMcpAccess(OWNER_PRINCIPAL)).toEqual({ kind: "owner" });
  });

  test("denies a scoped credential without workspace.write", () => {
    expect(
      resolveAgentMcpAccess({ principalId: "credential:viewer", permissions: ["workspace.read"] }),
    ).toEqual({ kind: "denied" });
  });

  test("hides tools whose permission the scoped credential lacks and carries its denied modes", () => {
    const access = resolveAgentMcpAccess({
      principalId: "credential:delegator",
      permissions: ["workspace.read", "workspace.write", "workspace.manage"],
      deniedModes: ["bypassPermissions"],
    });

    expect(access.kind).toBe("scoped");
    if (access.kind !== "scoped") return;
    expect(access.deniedModes).toEqual(["bypassPermissions"]);
    expect(access.toolPolicy.disabledTools).toContain("create_schedule");
    expect(access.toolPolicy.disabledTools).toContain("create_heartbeat");
    expect(access.toolPolicy.disabledTools).not.toContain("create_workspace");
    expect(access.toolPolicy.disabledTools).not.toContain("create_agent");
  });

  test("merges restrictions with a caller agent's tool policy", () => {
    expect(
      mergePaseoToolPolicies(
        { enabled: true, disabledTools: ["kill_agent"] },
        { disabledTools: ["create_schedule"] },
      ),
    ).toEqual({ enabled: true, disabledTools: ["kill_agent", "create_schedule"] });
    expect(mergePaseoToolPolicies(undefined, { disabledTools: ["x"] })).toEqual({
      disabledTools: ["x"],
    });
  });
});
