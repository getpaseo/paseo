import type { AcpConfigChange, AcpConfigureContext } from "@getpaseo/plugin/server/acp";
import { describe, expect, it } from "vitest";
import { legacyModes } from "./legacy-modes.js";

// The modes `hermes acp` (hermes-agent 8da31006f3) offers through `edit_approval_policy`.
const POLICY_MODES = [
  { id: "ask", label: "Default" },
  { id: "workspace_session", label: "Accept Edits" },
  { id: "session", label: "Don't Ask" },
];

async function configure(change: AcpConfigChange, modes = POLICY_MODES) {
  const applied: AcpConfigChange[] = [];
  const context: AcpConfigureContext = {
    sessionId: "session-1",
    config: { read: async () => ({}), set: async () => {} },
    request: async () => null,
    catalog: () => ({ models: [], modes }),
    apply: async (nativeChange) => {
      applied.push(nativeChange);
    },
  };
  const result = await legacyModes.configure!(change, context);
  return { result, applied };
}

describe("Hermes modes saved before Hermes was bundled", () => {
  it.each([
    ["default", "ask"],
    ["accept_edits", "workspace_session"],
    ["dont_ask", "session"],
  ])("applies saved mode %s as policy %s", async (saved, policy) => {
    expect(await configure({ target: "mode", value: saved })).toEqual({
      result: "handled",
      applied: [{ target: "mode", value: policy }],
    });
  });

  it("passes current policy modes through", async () => {
    expect(await configure({ target: "mode", value: "workspace_session" })).toEqual({
      result: "pass",
      applied: [],
    });
  });

  it("passes a saved mode through when Hermes offers it directly", async () => {
    const sessionModes = [
      { id: "default", label: "Default" },
      { id: "accept_edits", label: "Accept Edits" },
    ];
    expect(await configure({ target: "mode", value: "default" }, sessionModes)).toEqual({
      result: "pass",
      applied: [],
    });
  });

  it("passes a saved mode through when Hermes no longer offers its policy", async () => {
    expect(
      await configure({ target: "mode", value: "default" }, [{ id: "plan", label: "Plan" }]),
    ).toEqual({ result: "pass", applied: [] });
  });

  it("leaves other settings alone", async () => {
    expect(await configure({ target: "model", value: "default" })).toEqual({
      result: "pass",
      applied: [],
    });
  });
});
