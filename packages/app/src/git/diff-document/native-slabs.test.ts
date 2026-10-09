import { describe, expect, it } from "vitest";
import { FILE_HEADER_HEIGHT } from "./model";
import {
  buildNativeCanvasSlabs,
  nativeCanvasSlabsForViewport,
  nativeCanvasWindowBucket,
  nativeCanvasWindowTop,
} from "./native-slabs";
import type { DiffDocumentModel } from "./types";

function modelWithBodies(
  bodies: Array<{ path: string; bodyTop: number; bottom: number }>,
): DiffDocumentModel {
  return {
    files: bodies.map((body, fileIndex) => ({
      file: {} as never,
      fileIndex,
      path: body.path,
      top: body.bodyTop - FILE_HEADER_HEIGHT,
      headerHeight: FILE_HEADER_HEIGHT,
      bodyTop: body.bodyTop,
      bodyHeight: body.bottom - body.bodyTop,
      bottom: body.bottom,
      gutterWidth: 48,
      contentWidth: 500,
      rowStart: 0,
      rowEnd: 0,
      isCollapsed: body.bottom === body.bodyTop,
    })),
    rows: [],
    height: bodies.at(-1)?.bottom ?? 0,
    lineHeight: 20,
    layout: "unified",
    wrapLines: false,
    viewportWidth: 400,
    reviewGeometryKey: "",
  };
}

describe("native canvas slabs", () => {
  it("cuts large file bodies into fixed document-positioned slabs", () => {
    const slabs = buildNativeCanvasSlabs(
      modelWithBodies([
        { path: "small.ts", bodyTop: FILE_HEADER_HEIGHT, bottom: FILE_HEADER_HEIGHT + 200 },
        {
          path: "large.ts",
          bodyTop: FILE_HEADER_HEIGHT * 2 + 200,
          bottom: FILE_HEADER_HEIGHT * 2 + 3400,
        },
      ]),
      600,
    );

    expect(slabs.map(({ path, top, height }) => ({ path, top, height }))).toEqual([
      { path: "small.ts", top: 30, height: 200 },
      { path: "large.ts", top: 260, height: 768 },
      { path: "large.ts", top: 1028, height: 768 },
      { path: "large.ts", top: 1796, height: 768 },
      { path: "large.ts", top: 2564, height: 768 },
      { path: "large.ts", top: 3332, height: 128 },
    ]);
  });

  it("retains only viewport-adjacent slabs and updates on half-viewport boundaries", () => {
    const slabs = buildNativeCanvasSlabs(
      modelWithBodies([
        { path: "large.ts", bodyTop: FILE_HEADER_HEIGHT, bottom: FILE_HEADER_HEIGHT + 4800 },
      ]),
      600,
    );

    expect(nativeCanvasSlabsForViewport(slabs, 1700, 600).map((slab) => slab.top)).toEqual([
      798, 1566, 2334,
    ]);
    expect(nativeCanvasWindowBucket(899, 600)).toBe(2);
    expect(nativeCanvasWindowTop(2, 600)).toBe(600);
  });

  it("keeps slab identities stable when inline review geometry moves files", () => {
    const before = buildNativeCanvasSlabs(
      modelWithBodies([
        { path: "first.ts", bodyTop: 30, bottom: 230 },
        { path: "second.ts", bodyTop: 260, bottom: 3460 },
      ]),
      600,
    );
    const after = buildNativeCanvasSlabs(
      modelWithBodies([
        { path: "first.ts", bodyTop: 30, bottom: 378 },
        { path: "second.ts", bodyTop: 408, bottom: 3608 },
      ]),
      600,
    );

    expect(after.filter((slab) => slab.path === "second.ts").map((slab) => slab.key)).toEqual(
      before.filter((slab) => slab.path === "second.ts").map((slab) => slab.key),
    );
  });
});
