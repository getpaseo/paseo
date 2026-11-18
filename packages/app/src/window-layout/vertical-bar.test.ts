import { describe, expect, it, vi } from "vitest";
import type { WindowLayout } from "./model";

const folded: WindowLayout = {
  bounds: { x: 0, y: 0, width: 400, height: 900 },
  verticalBarEdge: "trailing",
  verticalBar: { x: 356, y: 160, width: 44, height: 450 },
  verticalBarBehavior: "automatic",
  divisions: [],
};

async function freshStore() {
  vi.resetModules();
  return import("./vertical-bar");
}

describe("vertical bar store", () => {
  it("reports the measured edge and behavior and notifies only on change", async () => {
    const bar = await freshStore();
    const listener = vi.fn();
    bar.subscribeVerticalBar(listener);

    expect(bar.getVerticalBar()).toEqual({ edge: "none", behavior: "automatic" });
    bar.reportVerticalBarLayout(folded);
    bar.reportVerticalBarLayout(folded);
    expect(bar.getVerticalBar()).toEqual({ edge: "trailing", behavior: "automatic" });
    expect(listener).toHaveBeenCalledTimes(1);

    bar.reportVerticalBarLayout({ ...folded, verticalBar: null, verticalBarBehavior: "disabled" });
    expect(bar.getVerticalBar()).toEqual({ edge: "trailing", behavior: "disabled" });
    bar.reportVerticalBarLayout(null);
    expect(bar.getVerticalBar()).toEqual({ edge: "none", behavior: "disabled" });
  });

  it("does nothing until a platform installs a controller", async () => {
    const bar = await freshStore();
    bar.setVerticalBarBehavior("disabled");
    const apply = vi.fn();
    bar.installVerticalBarController(apply);
    bar.setVerticalBarBehavior("disabled");
    expect(apply).toHaveBeenCalledWith("disabled");
  });
});
