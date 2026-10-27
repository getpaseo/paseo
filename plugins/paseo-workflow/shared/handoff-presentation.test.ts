import { describe, expect, it } from "vitest";
import {
  extractHandoffPlan,
  handoffPlanTitle,
  visibleHandoffProfiles,
} from "./handoff-presentation";

function envelope(plan: string, { crlf = false }: { crlf?: boolean } = {}) {
  const message = `/paseo-handoff\nPASEO_WORKFLOW_HANDOFF ${JSON.stringify({
    mode: "receiver",
    workflowId: "workflow-1",
    planId: "plan-1",
    role: "executor-bounded",
  })}\nExecute the approved plan.\n${JSON.stringify({ plan, git: { branch: "topic" } }, null, 2)}`;
  return crlf ? message.replace(/\n/g, "\r\n") : message;
}

describe("handoff plan presentation", () => {
  it("hides Workflow profiles from the handoff list and keeps the remaining order", () => {
    expect(
      visibleHandoffProfiles([
        { id: "first", name: "First" },
        { id: "workflow", name: "Workflow · planner" },
        { id: "lowercase", name: "workflow helper" },
        { id: "last", name: "Last" },
      ]).map(({ id }) => id),
    ).toEqual(["first", "lowercase", "last"]);
    expect(visibleHandoffProfiles([{ id: "only", name: "Workflow planner" }])).toEqual([]);
  });

  it("extracts a newly recorded handoff without changing multiline Markdown", () => {
    const plan = "# Fix the stream\n\n- Keep **bold**\n- Preserve `code`";
    expect(extractHandoffPlan(envelope(plan))).toEqual({ text: plan });
  });

  it("extracts stored handoffs with CRLF and escaped JSON characters", () => {
    const plan = '# Keep \\"quoted\\" text\n\n```ts\nconst n = 1;\n```';
    expect(extractHandoffPlan(envelope(plan, { crlf: true }))).toEqual({ text: plan });
  });

  it("leaves ordinary and malformed envelopes untouched", () => {
    expect(
      extractHandoffPlan("/paseo-handoff\nPASEO_WORKFLOW_HANDOFF {broken\n{}"),
    ).toBeUndefined();
    expect(extractHandoffPlan('A normal message with {"plan":"text"}')).toBeUndefined();
    expect(
      extractHandoffPlan(
        `/paseo-handoff\nPASEO_WORKFLOW_HANDOFF ${JSON.stringify({ mode: "receiver" })}\n${JSON.stringify({ plan: "# Hidden" })}`,
      ),
    ).toBeUndefined();
  });

  it("uses the first Markdown heading as a clean, bounded executor title", () => {
    expect(handoffPlanTitle("Intro\n\n## **Harmoniser `les couleurs`**\nMore")).toBe(
      "Harmoniser les couleurs",
    );
    expect(handoffPlanTitle("  First line\nSecond line")).toBe("First line");
    expect(handoffPlanTitle(" ")).toBe("Plan transféré");
    expect(handoffPlanTitle(`# ${"x".repeat(240)}`)).toHaveLength(200);
  });
});
