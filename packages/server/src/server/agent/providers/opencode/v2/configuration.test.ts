import { describe, expect, test } from "vitest";

import { controls, permissionRules } from "./configuration.js";

describe("OpenCode v2 permission rules", () => {
  test("maps authored native permissions and exact injected MCP grants", () => {
    expect(
      permissionRules({
        provider: "opencode",
        cwd: "/tmp/project",
        providerOptions: { permission: { bash: { pwd: "allow" }, task: "ask" } },
        toolPolicy: { preapproved: [{ server: "paseo.host", tool: "read/info" }] },
      }),
    ).toEqual([
      { action: "paseo_host_read_info", resource: "*", effect: "allow" },
      { action: "shell", resource: "pwd", effect: "allow" },
      { action: "subagent", resource: "*", effect: "ask" },
    ]);
  });
});

describe("OpenCode v2 controls", () => {
  test("describes the auto-accept toggle over the auto_accept option", () => {
    expect(controls).toEqual([{ type: "toggle", key: "auto_accept", label: "Auto-accept" }]);
  });
});
