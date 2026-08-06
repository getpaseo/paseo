import { describe, expect, it } from "vitest";
import type { PrHint } from "@/git/pr-hint";
import { DEFAULT_SIDEBAR_CHECKS_DISPLAY } from "@/components/sidebar/display-preferences/checks-display";
import { DEFAULT_SIDEBAR_ROW_ITEMS } from "@/components/sidebar/display-preferences/row-items";
import { selectMetaRowItems } from "./meta-items";
import type { WorkspaceServiceSummary } from "./service-summary";

const PR_HINT: PrHint = {
  url: "https://github.com/acme/app/pull/7",
  number: 7,
  state: "open",
  forge: "github",
  checksStatus: "success",
};

const SERVICE: WorkspaceServiceSummary = { name: "web", health: null };

function select(overrides: Partial<Parameters<typeof selectMetaRowItems>[0]> = {}) {
  return selectMetaRowItems({
    hasHostBadge: true,
    prHint: PR_HINT,
    serviceSummary: SERVICE,
    visible: DEFAULT_SIDEBAR_ROW_ITEMS,
    checksDisplay: DEFAULT_SIDEBAR_CHECKS_DISPLAY,
    ...overrides,
  });
}

const kinds = (items: ReturnType<typeof selectMetaRowItems>) => items.map((item) => item.kind);

describe("selectMetaRowItems", () => {
  it("reads identity, then the change, then its state, then what is running", () => {
    expect(kinds(select())).toEqual(["host", "changeRequest", "checks", "services"]);
  });

  it("omits what the workspace does not have", () => {
    expect(kinds(select({ hasHostBadge: false, prHint: null, serviceSummary: null }))).toEqual([]);
  });

  it.each([
    ["changeRequest", ["host", "checks", "services"]],
    ["services", ["host", "changeRequest", "checks"]],
  ] as const)("drops %s and only %s when it is switched off", (item, expected) => {
    expect(kinds(select({ visible: { ...DEFAULT_SIDEBAR_ROW_ITEMS, [item]: false } }))).toEqual(
      expected,
    );
  });

  it("drops checks and only checks when they are hidden", () => {
    expect(kinds(select({ checksDisplay: "none" }))).toEqual(["host", "changeRequest", "services"]);
  });

  it("keeps checks when the change request is hidden", () => {
    // Each control answers for itself. A checks setting that drew nothing because a different
    // switch was off would be lying about its own state.
    const items = select({ visible: { ...DEFAULT_SIDEBAR_ROW_ITEMS, changeRequest: false } });
    expect(kinds(items)).toEqual(["host", "checks", "services"]);
  });

  it("draws nothing for checks when both are off", () => {
    const items = select({
      visible: { ...DEFAULT_SIDEBAR_ROW_ITEMS, changeRequest: false },
      checksDisplay: "none",
    });
    expect(kinds(items)).toEqual(["host", "services"]);
  });

  it("carries the resolved check summary rather than the raw hint", () => {
    const checks = select().find((item) => item.kind === "checks");
    expect(checks).toEqual({
      kind: "checks",
      summary: { state: "passed", completed: 1, total: 1 },
      label: true,
    });
  });

  it("keeps the check summary but drops its word when only the icon is wanted", () => {
    const checks = select({ checksDisplay: "icon" }).find((item) => item.kind === "checks");
    expect(checks).toEqual({
      kind: "checks",
      summary: { state: "passed", completed: 1, total: 1 },
      label: false,
    });
  });

  it("keeps a change request whose forge reports no checks", () => {
    const items = select({ prHint: { ...PR_HINT, checksStatus: undefined } });
    expect(kinds(items)).toEqual(["host", "changeRequest", "services"]);
  });
});
