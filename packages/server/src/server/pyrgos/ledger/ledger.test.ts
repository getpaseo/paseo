import { describe, expect, it, vi } from "vitest";
import { createLedger, LedgerError, type LedgerItem, type LedgerStore } from "./ledger.js";

function memoryStore(): LedgerStore & { rows: LedgerItem[] } {
  const rows: LedgerItem[] = [];
  return {
    rows,
    append: (item) => {
      rows.push(item);
    },
    load: () => rows,
  };
}

function makeLedger(overrides: Partial<Parameters<typeof createLedger>[0]> = {}) {
  let n = 0;
  const store = memoryStore();
  const ledger = createLedger({
    store,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    newId: () => `a${++n}`,
    ...overrides,
  });
  return { ledger, store };
}

const COMPLETE = { scope: "one PR", project: "pyrgos-paseo", doneCriteria: "tests green" };

describe("ledger state machine", () => {
  it("proposes a draft with normalized text and a transcript ref", () => {
    const { ledger } = makeLedger();
    const item = ledger.propose({ item: "  ship   the\nledger ", transcriptRef: "s.jsonl#4" });
    expect(item).toMatchObject({
      id: "a1",
      state: "draft",
      item: "ship the ledger",
      scope: null,
      project: null,
      doneCriteria: null,
      transcriptRef: "s.jsonl#4",
    });
  });

  it("rejects an empty proposal", () => {
    const { ledger } = makeLedger();
    expect(() => ledger.propose({ item: "   " })).toThrow(LedgerError);
  });

  it("moves draft to refined and keeps unspecified fields", () => {
    const { ledger } = makeLedger();
    const { id } = ledger.propose({ item: "x" });
    ledger.refine(id, { scope: "s" });
    const refined = ledger.refine(id, { project: "p" });
    expect(refined).toMatchObject({
      state: "refined",
      scope: "s",
      project: "p",
      doneCriteria: null,
    });
  });

  it("refuses to agree a draft", async () => {
    const { ledger } = makeLedger();
    const { id } = ledger.propose({ item: "x" });
    await expect(ledger.agree(id, { confirmed: true })).rejects.toMatchObject({
      code: "bad_state",
    });
  });

  it.each([
    ["scope", { project: "p", doneCriteria: "d" }],
    ["project", { scope: "s", doneCriteria: "d" }],
    ["doneCriteria", { scope: "s", project: "p" }],
  ])("rejects agree when %s is missing", async (field, fields) => {
    const launch = vi.fn();
    const { ledger } = makeLedger({ launch });
    const { id } = ledger.propose({ item: "x" });
    ledger.refine(id, fields);
    await expect(ledger.agree(id, { confirmed: true })).rejects.toMatchObject({
      code: "incomplete",
    });
    await expect(ledger.agree(id, { confirmed: true })).rejects.toThrow(field);
    expect(ledger.get(id).state).toBe("refined");
    expect(launch).not.toHaveBeenCalled();
  });

  it("treats a blank field as missing", async () => {
    const { ledger } = makeLedger();
    const { id } = ledger.propose({ item: "x" });
    ledger.refine(id, { ...COMPLETE, scope: "   " });
    await expect(ledger.agree(id, { confirmed: true })).rejects.toMatchObject({
      code: "incomplete",
    });
  });

  it("agrees a complete item, announces it, then launches it", async () => {
    const order: string[] = [];
    const announce = vi.fn(async () => {
      order.push("announce");
    });
    const launch = vi.fn(async () => {
      order.push("launch");
    });
    const { ledger } = makeLedger({ announce, launch });
    const { id } = ledger.propose({ item: "x" });
    ledger.refine(id, COMPLETE);
    const agreed = await ledger.agree(id, { confirmed: true });
    expect(agreed.state).toBe("agreed");
    expect(order).toEqual(["announce", "launch"]);
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ id, state: "agreed" }));
  });

  it("keeps the item agreed and records the error when launch fails", async () => {
    const launch = vi.fn(async () => {
      throw new Error("no lane");
    });
    const { ledger } = makeLedger({ launch });
    const { id } = ledger.propose({ item: "x" });
    ledger.refine(id, COMPLETE);
    const agreed = await ledger.agree(id, { confirmed: true });
    expect(agreed).toMatchObject({ state: "agreed", launchError: "no lane" });
    expect(ledger.get(id).launchError).toBe("no lane");
  });

  it("does not launch twice", async () => {
    const launch = vi.fn(async () => {});
    const { ledger } = makeLedger({ launch });
    const { id } = ledger.propose({ item: "x" });
    ledger.refine(id, COMPLETE);
    await ledger.agree(id, { confirmed: true });
    await expect(ledger.agree(id, { confirmed: true })).rejects.toMatchObject({
      code: "bad_state",
    });
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("drops a draft or refined item and freezes it", () => {
    const { ledger } = makeLedger();
    const { id } = ledger.propose({ item: "x" });
    expect(ledger.drop(id, "changed my mind")).toMatchObject({
      state: "dropped",
      dropReason: "changed my mind",
    });
    expect(() => ledger.refine(id, { scope: "s" })).toThrow(LedgerError);
    expect(() => ledger.drop(id)).toThrow(LedgerError);
  });

  it("cannot drop an agreed item", async () => {
    const { ledger } = makeLedger();
    const { id } = ledger.propose({ item: "x" });
    ledger.refine(id, COMPLETE);
    await ledger.agree(id, { confirmed: true });
    expect(() => ledger.drop(id)).toThrow(LedgerError);
  });

  it("reports unknown ids", () => {
    const { ledger } = makeLedger();
    expect(() => ledger.get("nope")).toThrow(expect.objectContaining({ code: "not_found" }));
  });

  it("restores state from the store, latest row per id winning", () => {
    const { ledger, store } = makeLedger();
    const { id } = ledger.propose({ item: "x" });
    ledger.refine(id, COMPLETE);
    const restored = createLedger({ store });
    expect(restored.list()).toHaveLength(1);
    expect(restored.get(id)).toMatchObject({ state: "refined", project: "pyrgos-paseo" });
  });
});
