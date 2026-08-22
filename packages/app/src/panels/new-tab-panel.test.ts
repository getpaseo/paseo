import { describe, expect, it } from "vitest";
import { getLauncherActionOrder } from "@/panels/new-tab-action-order";

describe("getLauncherActionOrder", () => {
  it("leads with the work companion tools in the Side panel", () => {
    expect(getLauncherActionOrder(true)).toEqual([
      "changes",
      "files",
      "terminal",
      "agent",
      "browser",
      "pullRequest",
    ]);
  });

  it("leads with creating work in an ordinary pane", () => {
    expect(getLauncherActionOrder(false)).toEqual([
      "agent",
      "terminal",
      "changes",
      "files",
      "browser",
      "pullRequest",
    ]);
  });
});
