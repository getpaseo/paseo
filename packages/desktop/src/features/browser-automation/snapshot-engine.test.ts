import { describe, expect, it } from "vitest";
import { BrowserSnapshotEngine, type SnapshotPage } from "./snapshot-engine.js";

class SnapshotFixture implements SnapshotPage {
  public currentUrl = "https://example.com/form";
  public actionResult: unknown = true;

  public getURL(): string {
    return this.currentUrl;
  }

  public async executeJavaScript(code: string): Promise<unknown> {
    if (code.includes("CANDIDATE_SELECTOR")) {
      return JSON.stringify([
        {
          role: "textbox",
          tagName: "input",
          text: "Name",
          selector: "#name",
          attributes: { id: "name", type: "text" },
        },
        {
          role: "button",
          tagName: "button",
          text: "Drop",
          selector: "#drop",
          attributes: { id: "drop" },
        },
      ]);
    }
    return this.actionResult;
  }
}

describe("BrowserSnapshotEngine", () => {
  it("treats a false result from a ref action script as a stale ref", async () => {
    const page = new SnapshotFixture();
    const engine = new BrowserSnapshotEngine();
    await engine.snapshot({ browserId: "browser-1", page });

    page.actionResult = false;

    await expect(engine.click({ browserId: "browser-1", page, ref: "@e1" })).resolves.toEqual({
      ok: false,
      reason: "stale_ref",
    });
    await expect(engine.focus({ browserId: "browser-1", page, ref: "@e1" })).resolves.toEqual({
      ok: false,
      reason: "stale_ref",
    });
  });

  it("treats a false result from optional ref text/key actions as a stale ref", async () => {
    const page = new SnapshotFixture();
    const engine = new BrowserSnapshotEngine();
    await engine.snapshot({ browserId: "browser-1", page });

    page.actionResult = false;

    await expect(
      engine.typeText({ browserId: "browser-1", page, ref: "@e1", text: "Ada" }),
    ).resolves.toEqual({ ok: false, reason: "stale_ref" });
    await expect(
      engine.keypress({ browserId: "browser-1", page, ref: "@e1", key: "Enter" }),
    ).resolves.toEqual({ ok: false, reason: "stale_ref" });
  });

  it("treats a false result from drag as a stale ref", async () => {
    const page = new SnapshotFixture();
    const engine = new BrowserSnapshotEngine();
    await engine.snapshot({ browserId: "browser-1", page });

    page.actionResult = false;

    await expect(
      engine.drag({ browserId: "browser-1", page, sourceRef: "@e1", targetRef: "@e2" }),
    ).resolves.toEqual({ ok: false, reason: "stale_ref" });
  });
});
