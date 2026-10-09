import { describe, expect, it } from "vitest";
import {
  getPanelManifest,
  panelCanLaunchInPane,
  panelResourceKey,
  panelSupportsHost,
} from "@/panels/panel-manifest";

describe("panel manifest", () => {
  it("answers host support without React panel registration", () => {
    expect(panelSupportsHost("agent", "main")).toBe(true);
    expect(panelSupportsHost("agent", "explorer")).toBe(true);
    expect(panelSupportsHost("file", "explorer")).toBe(true);
    expect(panelSupportsHost("working_diff", "explorer")).toBe(true);
    expect(panelSupportsHost("new_tab", "explorer")).toBe(true);
    expect(panelSupportsHost("files", "explorer")).toBe(true);
    expect(panelSupportsHost("files", "main")).toBe(false);
    expect(panelSupportsHost("setup", "explorer")).toBe(false);
  });

  it("lets navigation tabs hide their close button without losing their close action", () => {
    expect(getPanelManifest("files").showCloseButton).toBe(false);
    expect(getPanelManifest("changes_tree").showCloseButton).toBe(false);
    expect(getPanelManifest("agent").showCloseButton).toBe(true);
    expect(getPanelManifest("terminal").showCloseButton).toBe(true);
    expect(getPanelManifest("file").showCloseButton).toBe(true);
    expect(getPanelManifest("working_diff").showCloseButton).toBe(true);
  });

  it("hides a singleton launch only when it already exists in the destination pane", () => {
    expect(panelCanLaunchInPane("files", ["files"])).toBe(false);
    expect(panelCanLaunchInPane("changes_tree", ["changes_tree"])).toBe(false);
    expect(panelCanLaunchInPane("files", ["changes_tree"])).toBe(true);
    expect(panelCanLaunchInPane("files", [])).toBe(true);
    expect(panelCanLaunchInPane("terminal", ["terminal"])).toBe(true);
  });

  it("keeps durable resource identity separate from transient target input", () => {
    expect(
      panelResourceKey({ kind: "working_diff", focusPath: "src/a.ts", focusRequestId: 1 }),
    ).toBe(panelResourceKey({ kind: "working_diff", focusPath: "src/b.ts", focusRequestId: 2 }));
    expect(panelResourceKey({ kind: "file", path: "src/a.ts" })).not.toBe(
      panelResourceKey({ kind: "file", path: "src/b.ts" }),
    );
  });
});
