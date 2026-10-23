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

  it("refuses to agree without confirmed: true", async () => {
    const launch = vi.fn(async () => {});
    const { ledger } = makeLedger({ launch });
    const { id } = ledger.propose({ item: "x" });
    ledger.refine(id, COMPLETE);
    // @ts-expect-error confirmed must be literally true
    await expect(ledger.agree(id, { confirmed: false })).rejects.toMatchObject({
      code: "unconfirmed",
    });
    // @ts-expect-error input is required
    await expect(ledger.agree(id, undefined)).rejects.toMatchObject({ code: "unconfirmed" });
    expect(ledger.get(id).state).toBe("refined");
    expect(launch).not.toHaveBeenCalled();
  });

  it("launches even when announce fails, and retries only the failed step", async () => {
    const announce = vi
      .fn<(item: LedgerItem) => Promise<void>>()
      .mockRejectedValueOnce(new Error("surface gone"))
      .mockResolvedValue(undefined);
    const launch = vi.fn(async () => {});
    const { ledger } = makeLedger({ announce, launch });
    const { id } = ledger.propose({ item: "x" });
    ledger.refine(id, COMPLETE);
    const first = await ledger.agree(id, { confirmed: true });
    expect(first).toMatchObject({ state: "agreed", launchError: "announce failed: surface gone" });
    expect(launch).toHaveBeenCalledTimes(1);
    const second = await ledger.agree(id, { confirmed: true });
    expect(second.launchError).toBeNull();
    expect(announce).toHaveBeenCalledTimes(2);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("does not relaunch when launch succeeded but its record failed to persist", async () => {
    const rows: LedgerItem[] = [];
    let failNext = false;
    const store: LedgerStore = {
      append: (item) => {
        if (failNext && item.launchedAt !== null) {
          failNext = false;
          throw new Error("disk full");
        }
        rows.push(item);
      },
      load: () => rows,
    };
    const launch = vi.fn(async () => {});
    const ledger = createLedger({ store, launch, newId: () => "u1" });
    const { id } = ledger.propose({ item: "x" });
    ledger.refine(id, COMPLETE);
    failNext = true;
    const first = await ledger.agree(id, { confirmed: true });
    expect(first.launchedAt).toBeNull();
    expect(first.launchError).toMatch(/not recorded: disk full/);
    expect(launch).toHaveBeenCalledTimes(1);
    const second = await ledger.agree(id, { confirmed: true });
    expect(second.launchedAt).not.toBeNull();
    expect(second.launchError).toBeNull();
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("retries a failed launch without re-announcing", async () => {
    const announce = vi.fn(async () => {});
    const launch = vi
      .fn<(item: LedgerItem) => Promise<void>>()
      .mockRejectedValueOnce(new Error("no lane"))
      .mockResolvedValue(undefined);
    const { ledger } = makeLedger({ announce, launch });
    const { id } = ledger.propose({ item: "x" });
    ledger.refine(id, COMPLETE);
    await ledger.agree(id, { confirmed: true });
    const retried = await ledger.agree(id, { confirmed: true });
    expect(retried.launchError).toBeNull();
    expect(launch).toHaveBeenCalledTimes(2);
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it("gives launch a durable id that survives retries and reload", async () => {
    const seen: (string | null)[] = [];
    const launch = vi
      .fn<(item: LedgerItem) => Promise<void>>()
      .mockImplementationOnce(async (item) => {
        seen.push(item.launchId);
        throw new Error("lost ack");
      })
      .mockImplementation(async (item) => {
        seen.push(item.launchId);
      });
    const { ledger, store } = makeLedger({ launch });
    const { id } = ledger.propose({ item: "x" });
    ledger.refine(id, COMPLETE);
    await ledger.agree(id, { confirmed: true });
    const reloaded = createLedger({ store, launch });
    await reloaded.agree(id, { confirmed: true });
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBeNull();
    expect(seen[1]).toBe(seen[0]);
    await expect(reloaded.agree(id, { confirmed: true })).rejects.toMatchObject({
      code: "bad_state",
    });
  });

  it("rejects an overlapping agree while one is in flight", async () => {
    let release: () => void = () => {};
    const launch = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const { ledger } = makeLedger({ launch });
    const { id } = ledger.propose({ item: "x" });
    ledger.refine(id, COMPLETE);
    const first = ledger.agree(id, { confirmed: true });
    await expect(ledger.agree(id, { confirmed: true })).rejects.toMatchObject({
      code: "bad_state",
    });
    release();
    await first;
    expect(launch).toHaveBeenCalledTimes(1);
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

  it("leaves no state behind when the store append fails", () => {
    const store = {
      append: () => {
        throw new Error("disk full");
      },
      load: () => [],
    };
    const ledger = createLedger({ store, newId: () => "x1" });
    expect(() => ledger.propose({ item: "x" })).toThrow("disk full");
    expect(ledger.list()).toHaveLength(0);
  });

  it("rejects a duplicate id instead of overwriting", () => {
    const { ledger } = makeLedger({ newId: () => "same" });
    ledger.propose({ item: "first" });
    expect(() => ledger.propose({ item: "second" })).toThrow(/already exists/);
    expect(ledger.get("same").item).toBe("first");
  });

  it("uses a full UUID by default", () => {
    const { ledger } = makeLedger({ newId: undefined });
    expect(ledger.propose({ item: "x" }).id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("returns copies, so mutating a result does not change ledger state", () => {
    const { ledger, store } = makeLedger();
    const created = ledger.propose({ item: "x" });
    created.state = "agreed";
    created.item = "hacked";
    ledger.get(created.id).item = "hacked";
    ledger.list()[0]!.state = "dropped";
    expect(ledger.get(created.id)).toMatchObject({ state: "draft", item: "x" });
    expect(store.rows).toHaveLength(1);
  });

  it("leaves state unchanged when an append fails during agree", async () => {
    const rows: LedgerItem[] = [];
    let failFrom = Infinity;
    const store: LedgerStore = {
      append: (item) => {
        if (rows.length >= failFrom) throw new Error("disk full");
        rows.push(item);
      },
      load: () => rows,
    };
    const ledger = createLedger({ store, newId: () => "k1" });
    const { id } = ledger.propose({ item: "x" });
    ledger.refine(id, COMPLETE);
    failFrom = rows.length;
    await expect(ledger.agree(id, { confirmed: true })).rejects.toThrow("disk full");
    expect(ledger.get(id).state).toBe("refined");
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
