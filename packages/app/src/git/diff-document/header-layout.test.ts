import { describe, expect, it } from "vitest";
import {
  diffHeaderViewportKey,
  diffInteractionWindowTop,
  resolveVisibleFileSections,
} from "./header-layout";
import type { DiffFileSection } from "./types";

describe("diff header viewport", () => {
  it("keeps a many-file document bounded by the viewport", () => {
    const files = Array.from({ length: 2_000 }, (_, index) => collapsedFile(index));

    const window = resolveVisibleFileSections({
      files,
      scrollTop: 30_000,
      viewportHeight: 600,
      overscan: 600,
    });

    expect(window.files.length).toBeLessThanOrEqual(61);
    expect(window.sticky?.file.fileIndex).toBe(1_000);
    expect(window.sticky?.y).toBe(0);
  });

  it("pins an expanded file whose original header is outside overscan", () => {
    const files = [expandedFile(0, 4_000), collapsedFile(1, 4_030)];

    const window = resolveVisibleFileSections({
      files,
      scrollTop: 2_000,
      viewportHeight: 600,
      overscan: 600,
    });

    expect(window.files.map((file) => file.path)).toEqual(["file-0.ts"]);
    expect(window.sticky).toEqual({ file: files[0], y: 0 });
  });

  it("pushes the pinned header out one pixel at a time", () => {
    const files = [expandedFile(0, 100), collapsedFile(1, 130)];

    expect(
      resolveVisibleFileSections({ files, scrollTop: 129, viewportHeight: 100, overscan: 0 }).sticky
        ?.y,
    ).toBe(-29);
    expect(
      resolveVisibleFileSections({ files, scrollTop: 130, viewportHeight: 100, overscan: 0 }).sticky
        ?.y,
    ).toBe(0);
  });

  it("reuses a fixed sticky header until its visible layout changes", () => {
    const files = [section(0, 0, 4_000, false), section(1, 4_000, 4_030, true)];
    const keyAt = (scrollTop: number) =>
      diffHeaderViewportKey({ files, scrollTop, viewportHeight: 600, activePath: null });

    expect(keyAt(100)).toBe(keyAt(2_000));
    expect(keyAt(3_985)).not.toBe(keyAt(2_000));
  });
});

describe("diff interaction window", () => {
  it("retains one shell window across two viewport heights", () => {
    expect(diffInteractionWindowTop(0, 500)).toBe(0);
    expect(diffInteractionWindowTop(999, 500)).toBe(0);
    expect(diffInteractionWindowTop(1_000, 500)).toBe(1_000);
  });
});

function collapsedFile(fileIndex: number, top = fileIndex * 30): DiffFileSection {
  return section(fileIndex, top, top + 30, true);
}

function expandedFile(fileIndex: number, bodyHeight: number): DiffFileSection {
  const top = fileIndex === 0 ? 0 : bodyHeight - 30;
  return section(fileIndex, top, top + 30 + bodyHeight, false);
}

function section(
  fileIndex: number,
  top: number,
  bottom: number,
  isCollapsed: boolean,
): DiffFileSection {
  const path = `file-${fileIndex}.ts`;
  return {
    file: {
      path,
      oldPath: undefined,
      additions: 1,
      deletions: 1,
      isNew: false,
      isDeleted: false,
      hunks: [],
    },
    fileIndex,
    path,
    top,
    headerHeight: 30,
    bodyTop: top + 30,
    bodyHeight: bottom - top - 30,
    bottom,
    gutterWidth: 30,
    contentWidth: 300,
    rowStart: 0,
    rowEnd: 0,
    isCollapsed,
  };
}
