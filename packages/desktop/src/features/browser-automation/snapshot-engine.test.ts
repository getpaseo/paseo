import { describe, expect, it } from "vitest";
import { BrowserSnapshotEngine, type SnapshotPage } from "./snapshot-engine.js";

class SnapshotFixture implements SnapshotPage {
  public currentUrl = "https://example.com/form";
  public actionResult: unknown = { ok: true };
  public alreadyTruncated = false;
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
        truncated: this.alreadyTruncated,
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

  it("builds a runtime ref expression with the snapshot fingerprint", async () => {
    const page = new SnapshotFixture();
    const engine = new BrowserSnapshotEngine();
    await engine.snapshot({ browserId: "browser-1", page });

    page.currentUrl = "https://example.com/form?panel=advanced";

    expect(engine.runtimeElementExpression({ browserId: "browser-1", ref: "@e1" })).toContain(
      '"name":"Save changes"',
    );
  });

  it("treats missing host-side ref metadata as a stale ref", async () => {
    const page = new SnapshotFixture();
    const engine = new BrowserSnapshotEngine();
    await engine.snapshot({ browserId: "browser-1", page });

    expect(engine.runtimeElementExpression({ browserId: "browser-1", ref: "@e2" })).toEqual({
      ok: false,
      reason: "missing_ref",
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

  it("keeps the last rendered node when a short snapshot was capped by node count", async () => {
    const page = new SnapshotFixture();
    page.alreadyTruncated = true;
    page.snapshotNodes = [
      {
        kind: "role",
        role: "button",
        name: "Final action",
        tagName: "button",
        attributes: [],
        ref: "@e1",
        fingerprint: {
          role: "button",
          name: "Final action",
          tagName: "button",
          type: "",
          ariaLabel: "",
        },
        children: [],
      },
    ];
    const engine = new BrowserSnapshotEngine();

    const snapshot = await engine.snapshot({ browserId: "browser-1", page });

    expect(snapshot.truncated).toBe(true);
    expect(snapshot.snapshot).toBe(
      [
        '- document "Fixture"',
        '  - button "Final action" [ref=@e1]',
        '- text: "Snapshot truncated."',
      ].join("\n"),
    );
  });
});
