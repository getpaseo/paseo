import { describe, expect, it } from "vitest";
import { getBuiltInLaunchOrder } from "./catalog";

describe("getBuiltInLaunchOrder", () => {
  it("leads with creating work in a primary pane", () => {
    expect(getBuiltInLaunchOrder("primary")).toEqual([
      "agent",
      "terminal",
      "changes",
      "files",
      "browser",
      "pullRequest",
    ]);
  });

  it("leads with companion tools in a supporting pane", () => {
    expect(getBuiltInLaunchOrder("supporting")).toEqual([
      "changes",
      "files",
      "terminal",
      "agent",
      "browser",
      "pullRequest",
    ]);
  });
});
