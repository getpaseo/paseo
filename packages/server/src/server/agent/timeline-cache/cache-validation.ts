import type { CatalogPageRef } from "./paged-catalog.js";
import type { SegmentDescriptor, TimelineSummary } from "./row-segment.js";

const CATALOG_FILE = /^catalog-[0-9a-f-]{36}\.json$/;
const SEGMENT_FILE = /^segment-([0-9]+)-[0-9a-f-]{36}\.json$/;

export function validateCatalogRef(value: unknown): asserts value is CatalogPageRef {
  if (!value || typeof value !== "object") throw new Error("Invalid catalog reference");
  const ref = value as Partial<CatalogPageRef>;
  if (
    typeof ref.file !== "string" ||
    !CATALOG_FILE.test(ref.file) ||
    !positive(ref.minSeq) ||
    !positive(ref.maxSeq) ||
    ref.minSeq > ref.maxSeq
  ) {
    throw new Error("Invalid catalog reference");
  }
  validateSummary(ref.summary);
  if (ref.summary.minSeq !== ref.minSeq || ref.summary.maxSeq !== ref.maxSeq) {
    throw new Error("Catalog reference summary mismatch");
  }
}

export function validateDescriptor(value: unknown): asserts value is SegmentDescriptor {
  if (!value || typeof value !== "object") throw new Error("Invalid segment descriptor");
  const descriptor = value as Partial<SegmentDescriptor>;
  const match = typeof descriptor.file === "string" ? SEGMENT_FILE.exec(descriptor.file) : null;
  if (
    !match ||
    !positive(descriptor.generation) ||
    Number(match[1]) !== descriptor.generation ||
    !positive(descriptor.minSeq) ||
    !positive(descriptor.maxSeq) ||
    descriptor.minSeq > descriptor.maxSeq
  ) {
    throw new Error("Invalid segment descriptor");
  }
  validateSummary(descriptor.summary);
  if (
    descriptor.summary.minSeq !== descriptor.minSeq ||
    descriptor.summary.maxSeq !== descriptor.maxSeq
  ) {
    throw new Error("Segment descriptor summary mismatch");
  }
}

export function validateSummary(value: unknown): asserts value is TimelineSummary {
  if (!value || typeof value !== "object") throw new Error("Invalid timeline summary");
  const summary = value as Partial<TimelineSummary>;
  if (
    !positive(summary.minSeq) ||
    !positive(summary.maxSeq) ||
    summary.minSeq > summary.maxSeq ||
    typeof summary.firstItemType !== "string" ||
    typeof summary.lastItemType !== "string"
  ) {
    throw new Error("Invalid timeline summary");
  }
  const trailing = summary.trailingAssistantStartSeq;
  if (!(trailing === null || inRange(trailing, summary.minSeq, summary.maxSeq))) {
    throw new Error("Invalid trailing assistant address");
  }
  const run = summary.lastAssistantRun;
  if (
    run !== null &&
    (!run ||
      !inRange(run.startSeq, summary.minSeq, summary.maxSeq) ||
      !inRange(run.endSeq, run.startSeq, summary.maxSeq))
  ) {
    throw new Error("Invalid assistant run address");
  }
}

export function validateOrderedRanges(values: readonly { minSeq: number; maxSeq: number }[]): void {
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1]!.maxSeq >= values[index]!.minSeq) {
      throw new Error("Catalog ranges overlap or are out of order");
    }
  }
}

function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function inRange(value: unknown, min: number, max: number): value is number {
  return positive(value) && min <= value && value <= max;
}
