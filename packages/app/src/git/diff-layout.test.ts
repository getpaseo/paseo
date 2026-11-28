import { describe, expect, test } from "vitest";
import { resolveDiffLayout } from "./diff-layout";

describe("resolveDiffLayout", () => {
  test("honors an explicit layout on a wide pane", () => {
    expect(resolveDiffLayout("unified", true, "xl")).toBe("unified");
    expect(resolveDiffLayout("split", true, "md")).toBe("split");
  });

  test("falls back to unified where split panes cannot fit", () => {
    expect(resolveDiffLayout("split", false, "xl")).toBe("unified");
  });

  test("auto splits only at the wide breakpoints", () => {
    expect(resolveDiffLayout("auto", true, "md")).toBe("unified");
    expect(resolveDiffLayout("auto", true, "lg")).toBe("split");
    expect(resolveDiffLayout("auto", true, "xl")).toBe("split");
  });

  test("auto stays unified on a pane that cannot split", () => {
    expect(resolveDiffLayout("auto", false, "xl")).toBe("unified");
  });
});
