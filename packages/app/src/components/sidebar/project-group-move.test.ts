import { beforeEach, describe, expect, it } from "vitest";
import {
  beginProjectGroupMove,
  finishProjectGroupMove,
  resetProjectGroupMovesForTest,
  resolveOrderWrite,
} from "./project-group-move";

const CLIENT_X = { groupKey: "client x", groupName: "Client X" };
const UNGROUPED = { groupKey: null, groupName: null };

/** What the sidebar shows: every project's group, as rendered. */
function shows(entries: Record<string, string | null>) {
  return new Map(Object.entries(entries));
}

beforeEach(resetProjectGroupMovesForTest);

describe("project group moves", () => {
  it("gives one project one unanswered move at a time", () => {
    const groupKeysByViewKey = shows({ a: null });
    expect(
      beginProjectGroupMove({ viewKey: "a", target: CLIENT_X, groupKeysByViewKey }),
    ).not.toBeNull();
    expect(
      beginProjectGroupMove({ viewKey: "a", target: UNGROUPED, groupKeysByViewKey }),
    ).toBeNull();
    finishProjectGroupMove({ viewKey: "a", accepted: true });
    expect(
      beginProjectGroupMove({ viewKey: "a", target: UNGROUPED, groupKeysByViewKey }),
    ).not.toBeNull();
  });

  it("keeps the guard across a sidebar that unmounted and came back", () => {
    // The module holds the pending move, so the second list sees it too.
    const groupKeysByViewKey = shows({ p: null });
    beginProjectGroupMove({ viewKey: "p", target: CLIENT_X, groupKeysByViewKey });
    expect(
      beginProjectGroupMove({ viewKey: "p", target: UNGROUPED, groupKeysByViewKey }),
    ).toBeNull();
  });

  it("counts a row the group accepted but has not shown yet as arriving", () => {
    const beforeReplica = shows({ a: null, b: null });
    beginProjectGroupMove({ viewKey: "a", target: CLIENT_X, groupKeysByViewKey: beforeReplica });
    finishProjectGroupMove({ viewKey: "a", accepted: true });
    const second = beginProjectGroupMove({
      viewKey: "b",
      target: CLIENT_X,
      groupKeysByViewKey: beforeReplica,
    });
    expect([...(second?.arrivingKeys ?? [])]).toEqual(["a"]);
  });

  it("does not count a row whose own move is still unanswered as arriving", () => {
    // A refused move never joined the group, and the order epoch replays the accepted ones, so
    // a row still waiting on its host must not anchor the next drop on the same header.
    const groupKeysByViewKey = shows({ a: null, b: null });
    beginProjectGroupMove({ viewKey: "a", target: CLIENT_X, groupKeysByViewKey });
    const second = beginProjectGroupMove({ viewKey: "b", target: CLIENT_X, groupKeysByViewKey });
    expect([...(second?.arrivingKeys ?? [])]).toEqual([]);
  });

  it("forgets an arriving row once the sidebar shows it in the group, or it disappears", () => {
    const before = shows({ a: null, b: null });
    beginProjectGroupMove({ viewKey: "a", target: CLIENT_X, groupKeysByViewKey: before });
    finishProjectGroupMove({ viewKey: "a", accepted: true });
    const replicated = shows({ a: "client x", b: null });
    const second = beginProjectGroupMove({
      viewKey: "b",
      target: CLIENT_X,
      groupKeysByViewKey: replicated,
    });
    expect([...(second?.arrivingKeys ?? [])]).toEqual([]);

    resetProjectGroupMovesForTest();
    beginProjectGroupMove({ viewKey: "a", target: CLIENT_X, groupKeysByViewKey: before });
    finishProjectGroupMove({ viewKey: "a", accepted: true });
    const gone = shows({ b: null });
    const third = beginProjectGroupMove({
      viewKey: "b",
      target: CLIENT_X,
      groupKeysByViewKey: gone,
    });
    expect([...(third?.arrivingKeys ?? [])]).toEqual([]);
  });

  it("stops treating a row as arriving once any record for it lands", () => {
    // The row was accepted into Client X and then moved elsewhere from the project menu, which
    // this tracker never sees. Any record landing retires the entry, whichever group it names.
    const before = shows({ a: null, b: null });
    beginProjectGroupMove({ viewKey: "a", target: CLIENT_X, groupKeysByViewKey: before });
    finishProjectGroupMove({ viewKey: "a", accepted: true });
    const second = beginProjectGroupMove({
      viewKey: "b",
      target: CLIENT_X,
      groupKeysByViewKey: shows({ a: "other", b: null }),
    });
    expect([...(second?.arrivingKeys ?? [])]).toEqual([]);
  });

  it("stops treating a row as arriving once its host refuses the move", () => {
    const groupKeysByViewKey = shows({ a: null, b: null });
    beginProjectGroupMove({ viewKey: "a", target: CLIENT_X, groupKeysByViewKey });
    finishProjectGroupMove({ viewKey: "a", accepted: false });
    const second = beginProjectGroupMove({ viewKey: "b", target: CLIENT_X, groupKeysByViewKey });
    expect([...(second?.arrivingKeys ?? [])]).toEqual([]);
  });

  it("only treats rows arriving in the same group as arriving", () => {
    const groupKeysByViewKey = shows({ a: null, b: null });
    beginProjectGroupMove({
      viewKey: "a",
      target: { groupKey: "other", groupName: "Other" },
      groupKeysByViewKey,
    });
    finishProjectGroupMove({ viewKey: "a", accepted: true });
    const second = beginProjectGroupMove({ viewKey: "b", target: CLIENT_X, groupKeysByViewKey });
    expect([...(second?.arrivingKeys ?? [])]).toEqual([]);
  });

  it("never reports an arriving row for a move out of every group", () => {
    const groupKeysByViewKey = shows({ a: null, b: "client x" });
    beginProjectGroupMove({ viewKey: "a", target: CLIENT_X, groupKeysByViewKey });
    finishProjectGroupMove({ viewKey: "a", accepted: true });
    const second = beginProjectGroupMove({ viewKey: "b", target: UNGROUPED, groupKeysByViewKey });
    expect([...(second?.arrivingKeys ?? [])]).toEqual([]);
  });
});

describe("resolveOrderWrite", () => {
  it("writes a relative drop next to the row it landed on", () => {
    expect(
      resolveOrderWrite({
        key: "a",
        target: CLIENT_X,
        position: { kind: "relative", anchorViewKey: "b", placement: "after" },
        arrivingKeys: new Set(),
      }),
    ).toEqual({
      kind: "move",
      key: "a",
      anchorKey: "b",
      placement: "after",
      groupKey: "client x",
    });
  });

  it("keeps a header drop's intent, with the arriving rows it was told about", () => {
    expect(
      resolveOrderWrite({
        key: "a",
        target: CLIENT_X,
        position: { kind: "group_start", firstViewKey: "t" },
        arrivingKeys: new Set(["x"]),
      }),
    ).toEqual({
      kind: "group_start",
      key: "a",
      groupKey: "client x",
      firstViewKey: "t",
      arrivingKeys: ["x"],
    });
  });

  it("records the new group but no move for a drop that keeps the row's place", () => {
    expect(
      resolveOrderWrite({
        key: "a",
        target: UNGROUPED,
        position: { kind: "keep" },
        arrivingKeys: new Set(),
      }),
    ).toEqual({ kind: "membership", key: "a", groupKey: null });
  });

  it("writes nothing for a header drop that names no group, which cannot happen", () => {
    expect(
      resolveOrderWrite({
        key: "a",
        target: UNGROUPED,
        position: { kind: "group_start", firstViewKey: "t" },
        arrivingKeys: new Set(),
      }),
    ).toBeNull();
  });
});
