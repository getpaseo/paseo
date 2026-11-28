import { describe, expect, test } from "vitest";

import { V2Harness } from "../test-utils/v2-harness.js";
import { applyResumeOverrides, controls, permissionRules } from "./configuration.js";

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

describe("OpenCode v2 resume variants", () => {
  test.each([
    { model: undefined, thinkingOptionId: "default", expectedId: "model" },
    { model: "test/other", thinkingOptionId: "default", expectedId: "other" },
    { model: "test/other", thinkingOptionId: null, expectedId: "other" },
    { model: "test/other", thinkingOptionId: undefined, expectedId: "other", variant: "medium" },
  ])(
    "resumes with the requested variant: $thinkingOptionId / $model",
    async ({ model, thinkingOptionId, expectedId, variant }) => {
      const harness = new V2Harness();
      harness.info.model = { providerID: "test", id: "model", variant: "medium" };
      const switches: Parameters<typeof harness.api.session.switchModel>[0][] = [];
      harness.api.session.switchModel = async (input) => {
        switches.push(input);
      };
      await applyResumeOverrides(harness.api, harness.info, { model, thinkingOptionId });
      const expected = { providerID: "test", id: expectedId, ...(variant ? { variant } : {}) };
      expect(switches).toEqual([{ sessionID: "session", model: expected }]);
      expect(harness.info.model).toEqual(expected);
    },
  );
});
