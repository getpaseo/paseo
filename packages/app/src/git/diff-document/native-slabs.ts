import { visibleRowRange } from "./model";
import type { DiffDocumentModel } from "./types";

export interface NativeCanvasSlab {
  key: string;
  path: string;
  fileIndex: number;
  top: number;
  height: number;
}

export function buildNativeCanvasSlabs(
  model: DiffDocumentModel,
  viewportHeight: number,
): NativeCanvasSlab[] {
  const slabHeight = Math.max(768, viewportHeight);
  const slabs: NativeCanvasSlab[] = [];
  for (const file of model.files) {
    let slabIndex = 0;
    for (let top = file.bodyTop; top < file.bottom; top += slabHeight, slabIndex += 1) {
      const height = Math.min(slabHeight, file.bottom - top);
      slabs.push({
        key: `${file.path}:${slabIndex}`,
        path: file.path,
        fileIndex: file.fileIndex,
        top,
        height,
      });
    }
  }
  return slabs;
}

export function nativeCanvasSlabsForViewport(
  slabs: readonly NativeCanvasSlab[],
  scrollTop: number,
  viewportHeight: number,
): NativeCanvasSlab[] {
  const top = Math.max(0, scrollTop - viewportHeight / 2);
  const bottom = scrollTop + viewportHeight * 1.5;
  const { start, end } = visibleRowRange(slabs, top, bottom - top);
  return slabs.slice(start, end);
}

export function nativeCanvasWindowBucket(scrollTop: number, viewportHeight: number): number {
  "worklet";
  return Math.floor(Math.max(0, scrollTop) / Math.max(1, viewportHeight / 2));
}

export function nativeCanvasWindowTop(bucket: number, viewportHeight: number): number {
  "worklet";
  return bucket * Math.max(1, viewportHeight / 2);
}
