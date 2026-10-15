import { expect, test } from "vitest";
import type { WorkspaceTodo } from "@getpaseo/protocol/workspace-todos";
import { groupTodoMilestones, mergeTodoOrder } from "./grouping";
const task = (id: string, milestone?: string): WorkspaceTodo => ({
  id,
  title: id,
  notes: "",
  status: "todo",
  titleProtected: false,
  notesProtected: false,
  milestone,
});
test("old and unassigned tasks remain visible and first occurrence orders milestones", () => {
  const tasks = [
    task("a"),
    task("b", "Build"),
    task("c", "Review"),
    task("d", "Build"),
    task("e", ""),
  ];
  expect(
    groupTodoMilestones(tasks).map((group) => [group.name, group.tasks.map((t) => t.id)]),
  ).toEqual([
    ["", ["a", "e"]],
    ["Build", ["b", "d"]],
    ["Review", ["c"]],
  ]);
  expect(groupTodoMilestones([])).toEqual([]);
});
test("dragging one milestone's visible subset preserves hidden and unrelated tasks", () => {
  const tasks = [task("a", "Build"), task("b", "Review"), task("c", "Build"), task("d", "Build")];
  expect(mergeTodoOrder(tasks, [tasks[3]!, tasks[0]!])).toEqual(["d", "b", "c", "a"]);
  expect(mergeTodoOrder(tasks, [])).toEqual(["a", "b", "c", "d"]);
});
