import { expect, test } from "vitest";
import { planCombineIntoTopic } from "./combine-into-topic-plan";

test("a typed name creates a topic for the selected sessions", () => {
  expect(
    planCombineIntoTopic({
      choice: { kind: "new", title: "  Riesling " },
      workspaceIds: ["wks_1", "wks_2", "wks_1"],
    }),
  ).toEqual({ kind: "create", title: "Riesling", workspaceIds: ["wks_1", "wks_2"] });
});

test("a picked topic assigns the sessions to it", () => {
  expect(
    planCombineIntoTopic({
      choice: { kind: "existing", topicId: "top_1" },
      workspaceIds: ["wks_1"],
    }),
  ).toEqual({ kind: "assign", topicId: "top_1", workspaceIds: ["wks_1"] });
});

test("nothing to submit without a name or without sessions", () => {
  expect(
    planCombineIntoTopic({ choice: { kind: "new", title: "   " }, workspaceIds: ["wks_1"] }),
  ).toBeNull();
  expect(
    planCombineIntoTopic({ choice: { kind: "existing", topicId: "top_1" }, workspaceIds: [] }),
  ).toBeNull();
});
