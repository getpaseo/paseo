import { describe, expect, it } from "vitest";
import { resolveLinkMenuTarget } from "./link-menu-target";

describe("resolveLinkMenuTarget", () => {
  it("routes web links to the web menu", () => {
    expect(
      resolveLinkMenuTarget(
        { kind: "resolved", value: { kind: "external", url: "https://example.com/x" } },
        null,
      ),
    ).toEqual({ kind: "external", url: "https://example.com/x" });
  });

  it("routes resolved file links to the file menu", () => {
    expect(
      resolveLinkMenuTarget(
        {
          kind: "resolved",
          value: { kind: "file", target: { raw: "REPORT.md", path: "REPORT.md" } },
        },
        null,
      ),
    ).toEqual({ kind: "file", path: "REPORT.md" });
  });

  it("uses the click path's resolved target once a lookup link resolves", () => {
    expect(
      resolveLinkMenuTarget(
        {
          kind: "needsLookup",
          ambiguousQuery: "report.md",
          token: "report.md",
          target: { raw: "report.md", path: "report.md" },
        },
        { raw: "report.md", path: "docs/report.md" },
      ),
    ).toEqual({ kind: "file", path: "docs/report.md" });
  });

  it("leaves ignored links and unresolved lookup links on the plain menu", () => {
    expect(
      resolveLinkMenuTarget({ kind: "resolved", value: { kind: "ignored" } }, null),
    ).toBeNull();
    expect(
      resolveLinkMenuTarget(
        {
          kind: "needsLookup",
          ambiguousQuery: "report.md",
          token: "report.md",
          target: { raw: "report.md", path: "report.md" },
        },
        null,
      ),
    ).toBeNull();
  });
});
