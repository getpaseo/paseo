import { beforeEach, describe, expect, it } from "vitest";
import {
  resetProjectOrderWriterForTest,
  settleProjectOrder,
  writeProjectOrder,
  type ProjectOrderHandle,
} from "./project-order-writer";

/**
 * A sidebar stand-in that writes the stored order the way `applyGroupMove` and
 * `handleSameListReorder` do, so a scenario reads like the drops a user makes. Every scenario is
 * replayed once per completion order of the hosts, and every one has to end the same way.
 */
function sidebar(initial: string[]) {
  resetProjectOrderWriterForTest();
  let order = initial;
  const io = {
    getOrder: () => order,
    setOrder: (keys: string[]) => {
      order = keys;
    },
  };
  const handles = new Map<string, ProjectOrderHandle | null>();
  return {
    get order() {
      return order;
    },
    setOrder: io.setOrder,
    /** A drop on a group header. `arrivingKeys` are rows accepted but not yet shown in it. */
    dropOnHeader(
      name: string,
      key: string,
      firstViewKey: string,
      arrivingKeys: string[] = [],
      groupKey = "target",
    ) {
      handles.set(
        name,
        writeProjectOrder(
          io,
          { kind: "group_start", key, groupKey, firstViewKey, arrivingKeys },
          "pending",
        ),
      );
    },
    dropNextTo(
      name: string,
      key: string,
      anchorKey: string,
      placement: "before" | "after",
      groupKey: string | null = null,
    ) {
      handles.set(
        name,
        writeProjectOrder(io, { kind: "move", key, anchorKey, placement, groupKey }, "pending"),
      );
    },
    /** A drop that keeps the row's place, like "Remove from group": the order does not change. */
    dropKeepingPlace(name: string, key: string, groupKey: string | null = null) {
      handles.set(name, writeProjectOrder(io, { kind: "membership", key, groupKey }, "pending"));
    },
    reorderList(visibleKeys: string[]) {
      writeProjectOrder(io, { kind: "splice", visibleKeys }, "accepted");
    },
    projectAppears(key: string) {
      order = [...order, key];
    },
    settle(name: string, status: "accepted" | "refused") {
      if (!handles.has(name)) throw new Error(`unknown write ${name}`);
      const handle = handles.get(name);
      if (handle) settleProjectOrder(io, handle, status);
    },
  };
}

type Settlement = [name: string, status: "accepted" | "refused"];

function permutations<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items];
  const result: T[][] = [];
  items.forEach((item, index) => {
    const others = [...items.slice(0, index), ...items.slice(index + 1)];
    for (const rest of permutations(others)) result.push([item, ...rest]);
  });
  return result;
}

/** Runs `setup` once per completion order of `settlements` and expects the same final order. */
function expectEveryCompletionOrder(
  setup: () => ReturnType<typeof sidebar>,
  settlements: Settlement[],
  expected: string[],
) {
  for (const sequence of permutations(settlements)) {
    const s = setup();
    for (const [name, status] of sequence) s.settle(name, status);
    expect(s.order, `completion order ${sequence.map(([name]) => name).join(",")}`).toEqual(
      expected,
    );
  }
}

beforeEach(resetProjectOrderWriterForTest);

describe("project order writer", () => {
  it("writes three header drops in drop order", () => {
    const s = sidebar(["a", "b", "c", "t"]);
    s.dropOnHeader("a", "a", "t");
    s.dropOnHeader("b", "b", "t");
    s.dropOnHeader("c", "c", "t");
    expect(s.order).toEqual(["c", "b", "a", "t"]);
  });

  it("restores the base order when every header drop is refused", () => {
    const setup = () => {
      const s = sidebar(["a", "b", "c", "t"]);
      s.dropOnHeader("a", "a", "t");
      s.dropOnHeader("b", "b", "t");
      s.dropOnHeader("c", "c", "t");
      return s;
    };
    expectEveryCompletionOrder(
      setup,
      [
        ["a", "refused"],
        ["b", "refused"],
        ["c", "refused"],
      ],
      ["a", "b", "c", "t"],
    );
  });

  it("keeps the accepted header drop and drops the refused ones", () => {
    const setup = () => {
      const s = sidebar(["a", "b", "c", "t"]);
      s.dropOnHeader("a", "a", "t");
      s.dropOnHeader("b", "b", "t");
      s.dropOnHeader("c", "c", "t");
      return s;
    };
    expectEveryCompletionOrder(
      setup,
      [
        ["a", "accepted"],
        ["b", "refused"],
        ["c", "refused"],
      ],
      ["b", "c", "a", "t"],
    );
  });

  it("keeps a later header drop ahead of the header when an earlier one is refused", () => {
    // The refused row is no longer in the group, so the row dropped after it belongs first.
    const setup = () => {
      const s = sidebar(["t", "a", "b"]);
      s.dropOnHeader("a", "a", "t");
      s.dropOnHeader("b", "b", "t");
      return s;
    };
    expectEveryCompletionOrder(
      setup,
      [
        ["a", "refused"],
        ["b", "accepted"],
      ],
      ["b", "t", "a"],
    );
    expectEveryCompletionOrder(
      setup,
      [
        ["a", "accepted"],
        ["b", "accepted"],
      ],
      ["b", "a", "t"],
    );
  });

  it("puts a header drop ahead of a row the group has accepted but not yet shown", () => {
    const s = sidebar(["t", "x", "b"]);
    s.dropOnHeader("b", "b", "t", ["x"]);
    expect(s.order).toEqual(["b", "t", "x"]);
  });

  it("keeps two drops on one group in drop order when its first row changed between them", () => {
    // x was accepted into the group and its replica landed, so the second drop names x as the
    // group's first row. Both drops are still the same group, so the later one goes first.
    const s = sidebar(["t", "a", "x", "b"]);
    s.dropOnHeader("a", "a", "t", ["x"]);
    s.dropOnHeader("b", "b", "x");
    s.settle("a", "accepted");
    s.settle("b", "accepted");
    expect(s.order).toEqual(["b", "a", "t", "x"]);
  });

  it("puts a header drop ahead of a row that a relative drop is putting in the same group", () => {
    // A was dropped just before the group's first row, so it is joining the group; B is then
    // dropped on the header and belongs ahead of it, whichever order the hosts answer in.
    const setup = () => {
      const s = sidebar(["t", "a", "b"]);
      s.dropNextTo("a", "a", "t", "before", "target");
      s.dropOnHeader("b", "b", "t");
      return s;
    };
    expectEveryCompletionOrder(
      setup,
      [
        ["a", "accepted"],
        ["b", "accepted"],
      ],
      ["b", "a", "t"],
    );
    // A refused arrival never joined the group, so B just goes ahead of the header's own row.
    expectEveryCompletionOrder(
      setup,
      [
        ["a", "refused"],
        ["b", "accepted"],
      ],
      ["b", "t", "a"],
    );
  });

  it("stops counting a row as arrived in a group it was dragged out of again", () => {
    // One unanswered write holds the epoch open across all of this. A joined G, then moved on to
    // H, so a later drop on G's header belongs ahead of G's own first row, not ahead of the row
    // that left. Without that, the result would depend on when the held write was answered.
    const setup = () => {
      const s = sidebar(["a", "h", "t", "b", "c", "d"]);
      s.dropNextTo("held", "c", "d", "after");
      s.dropNextTo("a1", "a", "t", "before", "g");
      s.settle("a1", "accepted");
      s.dropNextTo("a2", "a", "h", "before", "h");
      s.dropOnHeader("b", "b", "t", [], "g");
      return s;
    };
    expectEveryCompletionOrder(
      setup,
      [
        ["a2", "accepted"],
        ["b", "accepted"],
        ["held", "accepted"],
      ],
      ["a", "h", "b", "t", "d", "c"],
    );
  });

  it("keeps a relative drop next to its anchor when the anchor's own move is refused", () => {
    // a joins b's group after b; b tries to leave for d's group and is refused.
    const setup = () => {
      const s = sidebar(["a", "b", "c", "d"]);
      s.dropNextTo("a", "a", "b", "after");
      s.dropNextTo("b", "b", "d", "before");
      return s;
    };
    expectEveryCompletionOrder(
      setup,
      [
        ["a", "accepted"],
        ["b", "refused"],
      ],
      ["b", "a", "c", "d"],
    );
  });

  it("rolls a re-dragged row back to where its accepted move put it", () => {
    const setup = () => {
      const s = sidebar(["a", "b", "c", "t"]);
      s.dropOnHeader("a1", "a", "t");
      s.dropOnHeader("b", "b", "t");
      s.settle("a1", "accepted");
      s.dropNextTo("a2", "a", "c", "before");
      return s;
    };
    expectEveryCompletionOrder(
      setup,
      [
        ["b", "accepted"],
        ["a2", "refused"],
      ],
      ["c", "b", "a", "t"],
    );
  });

  it("treats a move that changes nothing like any other write", () => {
    const setup = () => {
      const s = sidebar(["b", "c", "a", "t"]);
      s.dropNextTo("a", "a", "c", "after");
      s.dropNextTo("c", "c", "b", "before");
      return s;
    };
    expectEveryCompletionOrder(
      setup,
      [
        ["a", "accepted"],
        ["c", "refused"],
      ],
      ["b", "c", "a", "t"],
    );
  });

  it("leaves projects that appeared mid-epoch where the sidebar put them", () => {
    const setup = () => {
      const s = sidebar(["p", "t"]);
      s.dropNextTo("p", "p", "t", "before");
      s.projectAppears("x");
      s.projectAppears("y");
      s.dropNextTo("x", "x", "p", "before");
      s.dropNextTo("y", "y", "p", "before");
      return s;
    };
    expectEveryCompletionOrder(
      setup,
      [
        ["p", "accepted"],
        ["x", "refused"],
        ["y", "refused"],
      ],
      ["p", "t", "x", "y"],
    );
  });

  it("keeps a reorder the user made while a move was pending, whichever way it settles", () => {
    const setup = () => {
      const s = sidebar(["a", "b", "c", "t"]);
      s.dropOnHeader("a", "a", "t");
      s.reorderList(["b", "a", "c"]);
      return s;
    };
    expectEveryCompletionOrder(setup, [["a", "refused"]], ["b", "a", "c", "t"]);
    expectEveryCompletionOrder(setup, [["a", "accepted"]], ["b", "a", "c", "t"]);
  });

  it("ignores a refused drop that wrote nothing", () => {
    const setup = () => {
      const s = sidebar(["a", "k", "t"]);
      s.dropOnHeader("a", "a", "t");
      s.dropKeepingPlace("k", "k");
      return s;
    };
    expectEveryCompletionOrder(
      setup,
      [
        ["k", "refused"],
        ["a", "refused"],
      ],
      ["a", "k", "t"],
    );
  });

  it("holds one epoch across a list that unmounts and comes back mid-write", () => {
    // Remounting the sidebar list swaps its callbacks but must not start a second epoch: both
    // writes belong to one history, so both refusals have to leave the order as it was.
    const s = sidebar(["a", "b", "c"]);
    s.dropNextTo("a", "a", "c", "after");
    const revived = sidebarSharingWriter(s);
    revived.dropNextTo("b", "b", "c", "after");
    s.settle("a", "refused");
    revived.settle("b", "refused");
    expect(s.order).toEqual(["a", "b", "c"]);
  });

  it("stops counting a row as arriving in a group it was dragged out of", () => {
    // One unanswered write holds the epoch open. A joined G, then left it through the
    // "Remove from group" zone, so B's drop on G's header belongs ahead of G's own first row.
    const setup = () => {
      const s = sidebar(["a", "t", "b", "h", "x"]);
      s.dropNextTo("held", "x", "h", "after");
      s.dropNextTo("a", "a", "t", "before", "g");
      s.settle("a", "accepted");
      s.dropKeepingPlace("out", "a", null);
      s.dropOnHeader("b", "b", "t", [], "g");
      return s;
    };
    expectEveryCompletionOrder(
      setup,
      [
        ["out", "accepted"],
        ["b", "accepted"],
        ["held", "accepted"],
      ],
      ["a", "b", "t", "h", "x"],
    );
  });

  it("writes a reorder straight through when nothing is pending", () => {
    const s = sidebar(["a", "b", "c"]);
    s.reorderList(["c", "a"]);
    expect(s.order).toEqual(["c", "b", "a"]);
  });

  it("leaves out a key the order no longer has instead of re-adding it", () => {
    const s = sidebar(["a", "b"]);
    s.dropNextTo("gone", "x", "a", "before");
    expect(s.order).toEqual(["a", "b"]);
    s.reorderList(["b", "x", "a"]);
    expect(s.order).toEqual(["b", "a"]);
  });
});

/** A second list over the same stored order, the way a remount gets fresh callbacks. */
function sidebarSharingWriter(existing: ReturnType<typeof sidebar>) {
  const io = {
    getOrder: () => existing.order,
    setOrder: (keys: string[]) => existing.setOrder(keys),
  };
  const handles = new Map<string, ProjectOrderHandle | null>();
  return {
    dropNextTo(name: string, key: string, anchorKey: string, placement: "before" | "after") {
      handles.set(
        name,
        writeProjectOrder(io, { kind: "move", key, anchorKey, placement }, "pending"),
      );
    },
    settle(name: string, status: "accepted" | "refused") {
      const handle = handles.get(name);
      if (handle) settleProjectOrder(io, handle, status);
    },
  };
}
