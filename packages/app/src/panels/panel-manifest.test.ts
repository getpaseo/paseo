import { describe, expect, it } from "vitest";
import { panelResourceKey, panelSupportsHost } from "@/panels/panel-manifest";

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

  it("keeps durable resource identity separate from transient target input", () => {
    expect(
      panelResourceKey({ kind: "working_diff", focusPath: "src/a.ts", focusRequestId: 1 }),
    ).toBe(panelResourceKey({ kind: "working_diff", focusPath: "src/b.ts", focusRequestId: 2 }));
    expect(panelResourceKey({ kind: "file", path: "src/a.ts" })).not.toBe(
      panelResourceKey({ kind: "file", path: "src/b.ts" }),
    );
  });
});
