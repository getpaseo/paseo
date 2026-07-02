import { describe, expect, it } from "vitest";
import { createToolPermissionPolicy, evaluateToolPermission } from "./agent-permissions.js";

describe("Paseo Agent tool permissions", () => {
  it("uses the first matching rule", () => {
    const allowFirst = createToolPermissionPolicy([
      { tool: "bash", action: "allow" },
      { tool: "bash", action: "deny" },
    ]);
    const denyFirst = createToolPermissionPolicy([
      { tool: "bash", action: "deny" },
      { tool: "bash", action: "allow" },
    ]);

    expect(evaluateToolPermission(allowFirst, "bash")).toBe("allow");
    expect(evaluateToolPermission(denyFirst, "bash")).toBe("deny");
  });

  it("matches wildcard tool names", () => {
    const policy = createToolPermissionPolicy([{ tool: "paseo__archive_*", action: "deny" }]);

    expect(evaluateToolPermission(policy, "paseo__archive_agent")).toBe("deny");
    expect(evaluateToolPermission(policy, "paseo__list_agents")).toBe("allow");
  });

  it("allows tools when no rule matches", () => {
    const policy = createToolPermissionPolicy([{ tool: "read", action: "deny" }]);

    expect(evaluateToolPermission(policy, "bash")).toBe("allow");
  });
});
