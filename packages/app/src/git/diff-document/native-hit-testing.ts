import { hitTestDiffDocument } from "./hit-testing";
import type { DiffDocumentModel, DiffFileSection, DiffHit } from "./types";

export function hitTestDiffBodyPoint(input: {
  model: DiffDocumentModel;
  file: DiffFileSection;
  locationX: number;
  locationY: number;
  horizontalOffset: number;
}): DiffHit | null {
  return hitTestDiffDocument({
    model: input.model,
    x: input.locationX,
    documentY: input.file.bodyTop + input.locationY,
    horizontalOffset: input.horizontalOffset,
  });
}
