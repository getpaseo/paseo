import { describe, expect, it } from "vitest";
import { parseHandoffMessage } from "./handoff-message";

const plan = "# Ship it\n\n- Keep **Markdown**\n- Preserve `code` and \\\\slashes";

function handoffMessage(overrides?: { metadata?: unknown; payload?: unknown }): string {
  const metadata =
    overrides?.metadata ??
    ({
      mode: "receiver",
      workflowId: "workflow-1",
      planId: "plan-1",
      role: "executor-bounded",
    } as const);
  const payload = overrides?.payload ?? { plan, git: { startHead: "abc123" } };
  return `/paseo-handoff\nPASEO_WORKFLOW_HANDOFF ${JSON.stringify(metadata)}\nExecute the approved plan here without creating another agent. Follow its scope and explicit authorizations; handoff grants no additional permissions. Preserve pre-existing and concurrent changes. Run targeted validation and report results and blockers.\n${JSON.stringify(payload, null, 2)}`;
}

describe("parseHandoffMessage", () => {
  it("returns the exact plan from a receiver handoff envelope", () => {
    expect(parseHandoffMessage(handoffMessage())).toEqual({ plan });
  });

  it.each([
    ["invalid metadata JSON", handoffMessage().replace('{"mode"', "{mode")],
    ["missing plan", handoffMessage({ payload: { git: {} } })],
    ["empty plan", handoffMessage({ payload: { plan: "  \n" } })],
    [
      "another mode",
      handoffMessage({
        metadata: {
          mode: "initiator",
          workflowId: "workflow-1",
          planId: "plan-1",
          role: "executor-bounded",
        },
      }),
    ],
    ["invalid payload JSON", handoffMessage().slice(0, -1)],
    ["quoted example", `Here is an example:\n\n${handoffMessage()}`],
  ])("rejects %s", (_name, message) => {
    expect(parseHandoffMessage(message)).toBeNull();
  });
});
