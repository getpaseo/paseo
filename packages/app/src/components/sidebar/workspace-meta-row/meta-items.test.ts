import { describe, expect, it } from "vitest";
import type { PrHint } from "@/git/pr-hint";
import { DEFAULT_SIDEBAR_ROW_ITEMS } from "@/components/sidebar/display-preferences/row-items";
import { selectMetaRowItems } from "./meta-items";
import type { WorkspaceScriptSummary } from "./script-summary";

const PR_HINT: PrHint = {
  url: "https://github.com/acme/app/pull/7",
  number: 7,
  state: "open",
  forge: "github",
  checksStatus: "success",
};

const SCRIPT: WorkspaceScriptSummary = { kind: "service", port: 3000 };

function select(overrides: Partial<Parameters<typeof selectMetaRowItems>[0]> = {}) {
  return selectMetaRowItems({
    hasHostBadge: true,
    prHint: PR_HINT,
    scriptSummary: SCRIPT,
    visible: DEFAULT_SIDEBAR_ROW_ITEMS,
    ...overrides,
  });
}

const kinds = (items: ReturnType<typeof selectMetaRowItems>) => items.map((item) => item.kind);

describe("selectMetaRowItems", () => {
  it("reads identity, then the change, then its state, then what is running", () => {
    expect(kinds(select())).toEqual(["host", "changeRequest", "checks", "scripts"]);
  });

  it("omits what the workspace does not have", () => {
    expect(kinds(select({ hasHostBadge: false, prHint: null, scriptSummary: null }))).toEqual([]);
  });

  it.each([
    ["changeRequest", ["host", "checks", "scripts"]],
    ["checks", ["host", "changeRequest", "scripts"]],
    ["scripts", ["host", "changeRequest", "checks"]],
  ] as const)("drops %s and only %s when it is switched off", (item, expected) => {
    expect(kinds(select({ visible: { ...DEFAULT_SIDEBAR_ROW_ITEMS, [item]: false } }))).toEqual(
      expected,
    );
  });

  it("keeps checks when the change request is hidden", () => {
    // Each toggle answers for itself. A ticked "checks" that drew nothing because a different
    // switch was off would be lying about its own state.
    const items = select({
      visible: { ...DEFAULT_SIDEBAR_ROW_ITEMS, changeRequest: false, checks: true },
    });
    expect(kinds(items)).toEqual(["host", "checks", "scripts"]);
  });

  it("draws nothing for checks when both are off", () => {
    const items = select({
      visible: { ...DEFAULT_SIDEBAR_ROW_ITEMS, changeRequest: false, checks: false },
    });
    expect(kinds(items)).toEqual(["host", "scripts"]);
  });

  it("carries the resolved check summary rather than the raw hint", () => {
    const checks = select().find((item) => item.kind === "checks");
    expect(checks).toEqual({
      kind: "checks",
      summary: { state: "passed", completed: 1, total: 1 },
    });
  });

  it("keeps a change request whose forge reports no checks", () => {
    const items = select({ prHint: { ...PR_HINT, checksStatus: undefined } });
    expect(kinds(items)).toEqual(["host", "changeRequest", "scripts"]);
  });
});
