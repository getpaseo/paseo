import { describe, expect, it } from "vitest";
import { createReadingAnchor, resolveInvertedReadingRow } from "./reading-anchor";

describe("reading anchor", () => {
  it("pins the folded turn host when a prepend replaces the row being read", () => {
    const anchor = createReadingAnchor();
    anchor.reconcile(0, [{ id: "tool", top: 48, height: 200 }]);
    const replacements = new Map([["tool", "prompt"]]);
    expect(anchor.getRowId(replacements)).toBe("prompt");
    expect(anchor.project(0, { id: "prompt", top: 1048 }, replacements)).toBe(1000);
    // Projection does not consume the correction; an unmounted host keeps the pin.
    expect(anchor.reconcile(0, [], false, replacements)).toBe(0);
    expect(anchor.getRowId()).toBe("tool");
    expect(
      anchor.reconcile(0, [{ id: "prompt", top: 1048, height: 100 }], false, replacements),
    ).toBe(1000);
    expect(anchor.getRowId()).toBe("prompt");
    expect(
      anchor.reconcile(1000, [{ id: "prompt", top: 1048, height: 100 }], false, replacements),
    ).toBe(1000);
  });

  const rows = [
    { id: "above", top: 0, height: 500 },
    { id: "reading", top: 500, height: 500 },
    { id: "below", top: 1000, height: 500 },
  ];

  it("preserves wheel movement during an asynchronous prepend", () => {
    const anchor = createReadingAnchor();
    anchor.reconcile(600, rows);
    expect(
      anchor.reconcile(
        440,
        rows.map((row) => ({ id: row.id, height: row.height, top: row.top + 2000 })),
      ),
    ).toBe(2440);
    expect(
      anchor.reconcile(
        2280,
        rows.map((row) => ({ id: row.id, height: row.height, top: row.top + 2000 })),
      ),
    ).toBe(2280);
  });

  it("ignores growth below the reader and compensates growth above", () => {
    const anchor = createReadingAnchor();
    anchor.reconcile(600, rows);
    expect(anchor.reconcile(600, [rows[0]!, rows[1]!, { ...rows[2]!, height: 2000 }])).toBe(600);
    expect(
      anchor.reconcile(600, [
        { ...rows[0]!, height: 1000 },
        { ...rows[1]!, top: 1000 },
        { ...rows[2]!, top: 1500 },
      ]),
    ).toBe(1100);
  });

  it("leaves expansion of the row being read in place", () => {
    const anchor = createReadingAnchor();
    anchor.reconcile(600, rows);
    expect(
      anchor.reconcile(600, [rows[0]!, { ...rows[1]!, height: 1000 }, { ...rows[2]!, top: 1500 }]),
    ).toBe(600);
  });

  it("keeps the existing reader through prepend measurements until the user scrolls", () => {
    const anchor = createReadingAnchor();
    anchor.reconcile(0, [{ id: "reading", top: 48, height: 100 }]);
    const prepended = [
      { id: "new", top: 2000, height: 57 },
      { id: "reading", top: 2057, height: 100 },
    ];
    expect(anchor.reconcile(0, prepended)).toBe(2009);
    expect(anchor.getRowId()).toBe("reading");
    const measured = [
      { id: "new", top: 2000, height: 100 },
      { id: "reading", top: 2100, height: 100 },
    ];
    expect(anchor.reconcile(2009, measured)).toBe(2052);
    expect(anchor.getRowId()).toBe("reading");
    expect(anchor.reconcile(2000, measured, true)).toBe(2000);
    expect(anchor.getRowId()).toBe("new");
  });

  it("retains the reader while the virtualizer initializes its mounted range", () => {
    const anchor = createReadingAnchor();
    anchor.reconcile(600, rows);
    anchor.reconcile(600, [rows[2]!]);
    expect(anchor.getRowId()).toBe("reading");
    expect(
      anchor.reconcile(
        600,
        rows.map((row) => ({ ...row, top: row.top + 2000 })),
      ),
    ).toBe(2600);
  });

  it("projects a prepend range without consuming the correction before layout commits", () => {
    const anchor = createReadingAnchor();
    anchor.reconcile(600, rows);
    expect(anchor.project(440, { id: "reading", top: 2500 })).toBe(2440);
    expect(anchor.project(440, { id: "reading", top: 2500 })).toBe(2440);
    expect(
      anchor.reconcile(
        440,
        rows.map((row) => ({ ...row, top: row.top + 2000 })),
        true,
      ),
    ).toBe(2440);
    expect(anchor.getRowId()).toBe("above");
  });

  it("repicks from user movement before applying a simultaneous layout correction", () => {
    const anchor = createReadingAnchor();
    anchor.reconcile(600, rows);
    anchor.scroll(440);
    expect(anchor.getRowId()).toBe("above");
    expect(
      anchor.reconcile(
        440,
        rows.map((row) => ({ ...row, top: row.top + 2000 })),
      ),
    ).toBe(2440);
    expect(anchor.getRowId()).toBe("above");
  });

  it("releases the old reading position for explicit navigation", () => {
    const anchor = createReadingAnchor();
    anchor.reconcile(600, rows);
    anchor.reset();
    expect(anchor.getRowId()).toBeNull();
    expect(
      anchor.reconcile(
        0,
        rows.map((row) => ({ id: row.id, height: row.height, top: row.top + 2000 })),
      ),
    ).toBe(0);
  });
});

describe("inverted reading row", () => {
  // Content runs from the visual bottom: the live head fills 0-100, then newer to older cells.
  const frames = new Map([
    ["newest", { y: 100, height: 200 }],
    ["middle", { y: 300, height: 400 }],
    ["oldest", { y: 700, height: 300 }],
  ]);

  function readAt(offsetY: number, topInset = 0) {
    return resolveInvertedReadingRow({ frames, offsetY, viewportHeight: 500, topInset });
  }

  it("reads the cell under the visual top of the viewport", () => {
    expect(readAt(0)).toEqual({ kind: "row", id: "middle" });
    expect(readAt(300)).toEqual({ kind: "row", id: "oldest" });
  });

  it("moves the reading line below an overlay floating over the top", () => {
    expect(readAt(300, 0)).toEqual({ kind: "row", id: "oldest" });
    expect(readAt(300, 120)).toEqual({ kind: "row", id: "middle" });
  });

  it("hands ownership to the next row only once the reading row clears the line", () => {
    // The visual top sits at content 708: "oldest" shows 8 points, which is not enough.
    expect(readAt(208)).toEqual({ kind: "row", id: "middle" });
    expect(readAt(210)).toEqual({ kind: "row", id: "oldest" });
  });

  it("reads a row whose top landed on the reading line despite sub-point rounding", () => {
    // "middle" ends at 700; the reading line sits at 700.4.
    expect(readAt(208.4)).toEqual({ kind: "row", id: "middle" });
    expect(readAt(209.5)).toEqual({ kind: "row", id: "oldest" });
  });

  it("reads the live head when every history cell is above the viewport", () => {
    expect(
      resolveInvertedReadingRow({ frames, offsetY: 0, viewportHeight: 90, topInset: 0 }),
    ).toEqual({ kind: "live-head" });
  });

  it("reads the nearest newer rendered cell over an unrendered gap", () => {
    const sparse = new Map([
      ["newest", { y: 100, height: 200 }],
      ["old", { y: 2000, height: 200 }],
    ]);
    expect(
      resolveInvertedReadingRow({ frames: sparse, offsetY: 500, viewportHeight: 500, topInset: 0 }),
    ).toEqual({ kind: "row", id: "newest" });
    expect(
      resolveInvertedReadingRow({
        frames: sparse,
        offsetY: 4000,
        viewportHeight: 500,
        topInset: 0,
      }),
    ).toEqual({ kind: "row", id: "old" });
  });

  it("reads nothing before any cell has laid out", () => {
    expect(
      resolveInvertedReadingRow({
        frames: new Map(),
        offsetY: 0,
        viewportHeight: 500,
        topInset: 0,
      }),
    ).toBeNull();
  });
});
