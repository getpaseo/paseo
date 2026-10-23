import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { groupByState, parseLedgerRows } from "../shared/ledger-view";
import { LedgerList } from "./ledger-list";

const fixture = readFileSync(join(__dirname, "../fixtures/session.ledger.jsonl"), "utf8");
const colors = {
  background: "#000",
  foreground: "#fff",
  muted: "#888",
  accent: "#0af",
  danger: "#f00",
};

describe("ledger view", () => {
  it("keeps the latest row per id", () => {
    const items = parseLedgerRows(fixture);
    expect(items).toHaveLength(5);
    expect(items.find((entry) => entry.id === "a2")?.state).toBe("refined");
  });

  it("groups by state in lifecycle order", () => {
    const groups = groupByState(parseLedgerRows(fixture));
    expect(groups.map((group) => [group.state, group.items.length])).toEqual([
      ["draft", 1],
      ["refined", 2],
      ["agreed", 1],
      ["dropped", 1],
    ]);
  });

  it("skips malformed rows", () => {
    expect(parseLedgerRows('{"id":1}\nnot json\n')).toEqual([]);
  });
});

describe("LedgerList", () => {
  const html = renderToStaticMarkup(
    <LedgerList items={parseLedgerRows(fixture)} colors={colors} compact={false} />,
  );

  it("renders every state group and item from the fixture", () => {
    for (const state of ["draft", "refined", "agreed", "dropped"]) {
      expect(html).toContain(`ledger-group-${state}`);
    }
    for (const id of ["a1", "a2", "a3", "a4", "a5"]) {
      expect(html).toContain(`ledger-item-${id}`);
    }
    expect(html).toContain("Add the ledger panel");
  });

  it("flags what a refined item still needs and what is ready", () => {
    expect(html).toContain("Needs: done-criteria");
    expect(html).toContain("Ready to confirm");
  });

  it("shows launch failures and drop reasons", () => {
    expect(html).toContain("Launch failed: no lane free");
    expect(html).toContain("Dropped: not needed");
  });
});
