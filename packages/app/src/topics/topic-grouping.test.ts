import { describe, expect, test } from "vitest";
import type { WorkspaceStateBucket } from "@getpaseo/protocol/agent-state-bucket";
import type { WorkspaceTopic } from "@getpaseo/protocol/messages";
import { groupWorkspacesByTopic, listWorkspaceTopics } from "./topic-grouping";

const riesling: WorkspaceTopic = { id: "top_riesling", title: "Riesling", description: null };
const payments: WorkspaceTopic = { id: "top_payments", title: "Payments", description: "Q4" };

function workspace(
  id: string,
  status: WorkspaceStateBucket,
  topic: WorkspaceTopic | null = null,
  costUsd: number | null = null,
) {
  return { id, status, topic, costUsd };
}

describe("groupWorkspacesByTopic", () => {
  test("puts children under their topic and leaves the rest ungrouped, in input order", () => {
    const result = groupWorkspacesByTopic([
      workspace("phase-2", "done", riesling),
      workspace("solo", "running"),
      workspace("checkout", "done", payments),
      workspace("phase-1", "done", riesling),
    ]);

    expect(result.topics.map((group) => group.topic.id)).toEqual(["top_riesling", "top_payments"]);
    expect(result.topics[0]?.children.map((child) => child.id)).toEqual(["phase-2", "phase-1"]);
    expect(result.ungrouped.map((item) => item.id)).toEqual(["solo"]);
  });

  test("a topic takes the most urgent state of its children", () => {
    const cases: [WorkspaceStateBucket[], WorkspaceStateBucket][] = [
      [["done", "running"], "running"],
      [["running", "failed", "attention"], "failed"],
      [["failed", "needs_input"], "needs_input"],
      [["done", "attention"], "attention"],
      [["done", "done"], "done"],
    ];
    for (const [statuses, expected] of cases) {
      const { topics } = groupWorkspacesByTopic(
        statuses.map((status, index) => workspace(`w${index}`, status, riesling)),
      );
      expect(topics[0]?.status).toBe(expected);
    }
  });

  test("sums the cost of children that report one", () => {
    const withCosts = [
      workspace("a", "done", riesling, 1.25),
      workspace("b", "done", riesling, null),
      workspace("c", "done", riesling, 0.5),
      workspace("d", "done", payments, null),
    ];
    const { topics } = groupWorkspacesByTopic(withCosts, (item) => item.costUsd);
    expect(topics[0]?.costUsd).toBe(1.75);
    expect(topics[1]?.costUsd).toBeNull();
    expect(groupWorkspacesByTopic(withCosts).topics[0]?.costUsd).toBeNull();
  });
});

test("listWorkspaceTopics lists each visible topic once", () => {
  expect(
    listWorkspaceTopics([
      workspace("a", "done", riesling),
      workspace("b", "done"),
      workspace("c", "done", payments),
      workspace("d", "done", riesling),
    ]),
  ).toEqual([riesling, payments]);
});
