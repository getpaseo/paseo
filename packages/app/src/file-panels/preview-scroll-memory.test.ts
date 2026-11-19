import { describe, expect, it } from "vitest";
import {
  clearPreviewScrollMemory,
  previewScrollKey,
  readPreviewScroll,
  writePreviewScroll,
} from "./preview-scroll-memory";

describe("previewScrollKey", () => {
  it("keeps the two views of one file apart", () => {
    const base = { workspaceId: "wks_1", path: "docs/plan.md" };

    expect(previewScrollKey({ ...base, view: "preview" })).not.toBe(
      previewScrollKey({ ...base, view: "source" }),
    );
  });

  it("keeps the same path in two workspaces apart", () => {
    const base = { path: "docs/plan.md", view: "preview" as const };

    expect(previewScrollKey({ ...base, workspaceId: "a" })).not.toBe(
      previewScrollKey({ ...base, workspaceId: "b" }),
    );
  });
});

describe("preview scroll memory", () => {
  it("returns what was written", () => {
    clearPreviewScrollMemory();
    writePreviewScroll("k", 420);

    expect(readPreviewScroll("k")).toBe(420);
  });

  it("forgets a view left at the top", () => {
    writePreviewScroll("k", 420);
    writePreviewScroll("k", 0);

    expect(readPreviewScroll("k")).toBe(0);
  });

  it("ignores offsets that are not a position", () => {
    clearPreviewScrollMemory();
    writePreviewScroll("k", Number.NaN);

    expect(readPreviewScroll("k")).toBe(0);
  });

  it("keeps the memory bounded", () => {
    clearPreviewScrollMemory();
    for (let index = 0; index < 200; index += 1) writePreviewScroll(`k${index}`, index + 1);

    expect(readPreviewScroll("k0")).toBe(0);
    expect(readPreviewScroll("k199")).toBe(200);
  });
});
