import { describe, expect, it } from "vitest";
import { BrowserSnapshotEngine, type SnapshotPage } from "./snapshot-engine.js";

class SnapshotFixture implements SnapshotPage {
  public currentUrl = "https://example.com/form";
  public actionResult: unknown = { ok: true };
  public snapshotNodes: unknown[] = [
    {
      kind: "role",
      role: "heading",
      name: "Settings",
      tagName: "h1",
      attributes: ["level=1"],
      children: [],
    },
    { kind: "text", text: "Connected as Maya" },
    {
      kind: "role",
      role: "button",
      name: "Save changes",
      tagName: "button",
      attributes: [],
      ref: "@e1",
      fingerprint: {
        role: "button",
        name: "Save changes",
        tagName: "button",
        type: "",
        ariaLabel: "",
      },
      children: [],
    },
  ];

  public getURL(): string {
    return this.currentUrl;
  }

  public async executeJavaScript(code: string): Promise<unknown> {
    if (code.includes("__PASEO_ARIA_SNAPSHOT__")) {
      return JSON.stringify({
        marker: "__PASEO_ARIA_SNAPSHOT__",
        root: {
          kind: "role",
          role: "document",
          name: "Fixture",
          tagName: "document",
          attributes: [],
          children: this.snapshotNodes,
        },
        refs: [
          {
            ref: "@e1",
            fingerprint: {
              role: "button",
              name: "Save changes",
              tagName: "button",
              type: "",
              ariaLabel: "",
            },
          },
        ],
        truncated: false,
        stats: { nodeCount: 4, refCount: 1, textLength: 0, iframeCount: 0, maxDepth: 1 },
      });
    }
    return this.actionResult;
  }
}

describe("BrowserSnapshotEngine", () => {
  it("renders a hierarchical ARIA YAML snapshot with static text and actionable refs", async () => {
    const page = new SnapshotFixture();
    const engine = new BrowserSnapshotEngine();

    await expect(engine.snapshot({ browserId: "browser-1", page })).resolves.toEqual({
      format: "aria-yaml",
      snapshot: [
        '- document "Fixture"',
        '  - heading "Settings" [level=1]',
        '  - text: "Connected as Maya"',
        '  - button "Save changes" [ref=@e1]',
      ].join("\n"),
      truncated: false,
      stats: { nodeCount: 4, refCount: 1, textLength: 119, iframeCount: 0, maxDepth: 1 },
    });
  });

  it("resolves refs after SPA pushState when the page runtime still matches the fingerprint", async () => {
    const page = new SnapshotFixture();
    const engine = new BrowserSnapshotEngine();
    await engine.snapshot({ browserId: "browser-1", page });

    page.currentUrl = "https://example.com/form?panel=advanced";

    await expect(engine.click({ browserId: "browser-1", page, ref: "@e1" })).resolves.toEqual({
      ok: true,
    });
  });

  it("treats a same-URL page-runtime mismatch as a stale ref", async () => {
    const page = new SnapshotFixture();
    const engine = new BrowserSnapshotEngine();
    await engine.snapshot({ browserId: "browser-1", page });

    page.actionResult = { ok: false, reason: "stale_ref" };

    await expect(engine.click({ browserId: "browser-1", page, ref: "@e1" })).resolves.toEqual({
      ok: false,
      reason: "stale_ref",
    });
  });

  it("marks rendered output truncation explicitly and deterministically", async () => {
    const page = new SnapshotFixture();
    page.snapshotNodes = [
      {
        kind: "text",
        text: "A".repeat(81_000),
      },
    ];
    const engine = new BrowserSnapshotEngine();

    const snapshot = await engine.snapshot({ browserId: "browser-1", page });

    expect(snapshot.truncated).toBe(true);
    expect(snapshot.snapshot.endsWith('- text: "Snapshot truncated."')).toBe(true);
    expect(snapshot.stats.textLength).toBeLessThanOrEqual(80_000);
  });
});
