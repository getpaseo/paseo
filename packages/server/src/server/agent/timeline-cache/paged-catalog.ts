import { randomUUID } from "node:crypto";
import path from "node:path";

import { writeFileAtomic } from "../../atomic-file.js";
import {
  validateCatalogRef,
  validateDescriptor,
  validateOrderedRanges,
} from "./cache-validation.js";
import type { SegmentDescriptor, TimelineSummary } from "./row-segment.js";
import { combineTimelineSummaries } from "./row-segment.js";
import { readJsonFileCapped } from "./safe-json-file.js";

export interface CatalogPageRef {
  file: string;
  minSeq: number;
  maxSeq: number;
  summary: TimelineSummary;
}

interface LeafPage {
  version: 1;
  kind: "leaf";
  entries: SegmentDescriptor[];
}

interface InternalPage {
  version: 1;
  kind: "internal";
  children: CatalogPageRef[];
}

type CatalogPage = LeafPage | InternalPage;

export interface PagedTimelineCatalogOptions {
  fanout?: number;
  maxPageBytes?: number;
  onPageRead?: (filePath: string) => void;
  writeFileAtomic?: (filePath: string, data: string) => Promise<void>;
  maxTraversalDepth?: number;
}

export interface CatalogReachability {
  pageFiles: Set<string>;
  segments: SegmentDescriptor[];
}

const DEFAULT_FANOUT = 64;
const DEFAULT_MAX_PAGE_BYTES = 64 * 1024;
const DEFAULT_MAX_TRAVERSAL_DEPTH = 32;

export class PagedTimelineCatalog {
  private readonly fanout: number;
  private readonly maxPageBytes: number;
  private readonly onPageRead?: (filePath: string) => void;
  private readonly writeAtomic: (filePath: string, data: string) => Promise<void>;
  private readonly maxTraversalDepth: number;

  constructor(
    private readonly directory: string,
    options?: PagedTimelineCatalogOptions,
  ) {
    this.fanout = options?.fanout ?? DEFAULT_FANOUT;
    this.maxPageBytes = options?.maxPageBytes ?? DEFAULT_MAX_PAGE_BYTES;
    this.onPageRead = options?.onPageRead;
    this.writeAtomic = options?.writeFileAtomic ?? writeFileAtomic;
    this.maxTraversalDepth = options?.maxTraversalDepth ?? DEFAULT_MAX_TRAVERSAL_DEPTH;
    if (!Number.isSafeInteger(this.fanout) || this.fanout < 2) {
      throw new Error("fanout must be a safe integer of at least 2");
    }
    if (!Number.isSafeInteger(this.maxPageBytes) || this.maxPageBytes < 1) {
      throw new Error("maxPageBytes must be a positive safe integer");
    }
    if (!Number.isSafeInteger(this.maxTraversalDepth) || this.maxTraversalDepth < 1) {
      throw new Error("maxTraversalDepth must be a positive safe integer");
    }
  }

  async append(
    root: CatalogPageRef | null,
    descriptor: SegmentDescriptor,
  ): Promise<CatalogPageRef> {
    validateDescriptor(descriptor);
    if (!root) return await this.writePage({ version: 1, kind: "leaf", entries: [descriptor] });
    validateCatalogRef(root);
    if (root.maxSeq >= descriptor.minSeq) {
      throw new Error("Catalog append ranges must be strictly increasing");
    }
    const replacements = await this.appendToPage(root, descriptor);
    if (replacements.length === 1) return replacements[0]!;
    return await this.writePage({ version: 1, kind: "internal", children: replacements });
  }

  async find(root: CatalogPageRef | null, seq: number): Promise<SegmentDescriptor | null> {
    let current = root;
    const visited = new Set<string>();
    let depth = 0;
    while (current) {
      validateCatalogRef(current);
      if (visited.has(current.file)) throw new Error("Catalog page cycle detected");
      if (depth >= this.maxTraversalDepth) throw new Error("Catalog traversal depth exceeded");
      visited.add(current.file);
      depth += 1;
      if (seq < current.minSeq || seq > current.maxSeq) return null;
      const page = await this.readPage(current);
      if (page.kind === "leaf") {
        return page.entries.find((entry) => entry.minSeq <= seq && seq <= entry.maxSeq) ?? null;
      }
      current = binaryFindRange(page.children, seq);
    }
    return null;
  }

  async before(
    root: CatalogPageRef | null,
    beforeSeq: number,
    limit: number,
  ): Promise<SegmentDescriptor[]> {
    if (!root || limit <= 0) return [];
    const descending: SegmentDescriptor[] = [];
    await this.collectBefore(root, beforeSeq, limit, descending);
    return descending.toReversed();
  }

  async after(
    root: CatalogPageRef | null,
    afterSeq: number,
    limit: number,
  ): Promise<SegmentDescriptor[]> {
    if (!root || limit <= 0) return [];
    const ascending: SegmentDescriptor[] = [];
    await this.collectAfter(root, afterSeq, limit, ascending);
    return ascending;
  }

  async collectReachable(root: CatalogPageRef | null): Promise<CatalogReachability> {
    const result: CatalogReachability = { pageFiles: new Set(), segments: [] };
    if (root) await this.collectReachablePage(root, result);
    return result;
  }

  async replace(
    root: CatalogPageRef | null,
    seq: number,
    descriptor: SegmentDescriptor,
  ): Promise<CatalogPageRef> {
    validateDescriptor(descriptor);
    if (!root) throw new Error(`Cannot replace missing catalog sequence ${seq}`);
    if (descriptor.minSeq > seq || descriptor.maxSeq < seq) {
      throw new Error("Replacement descriptor does not contain the target sequence");
    }
    return await this.replaceInPage(root, seq, descriptor);
  }

  private async replaceInPage(
    ref: CatalogPageRef,
    seq: number,
    descriptor: SegmentDescriptor,
  ): Promise<CatalogPageRef> {
    const page = await this.readPage(ref);
    if (page.kind === "leaf") {
      const index = page.entries.findIndex((entry) => entry.minSeq <= seq && seq <= entry.maxSeq);
      if (index < 0) throw new Error(`Cannot replace missing catalog sequence ${seq}`);
      const entries = page.entries.with(index, descriptor);
      return await this.writePage({ version: 1, kind: "leaf", entries });
    }
    const index = page.children.findIndex((child) => child.minSeq <= seq && seq <= child.maxSeq);
    if (index < 0) throw new Error(`Cannot replace missing catalog sequence ${seq}`);
    const replacement = await this.replaceInPage(page.children[index]!, seq, descriptor);
    const children = page.children.with(index, replacement);
    return await this.writePage({ version: 1, kind: "internal", children });
  }

  private async collectReachablePage(
    ref: CatalogPageRef,
    result: CatalogReachability,
    depth = 0,
  ): Promise<void> {
    validateCatalogRef(ref);
    if (result.pageFiles.has(ref.file)) throw new Error("Catalog page cycle detected");
    if (depth >= this.maxTraversalDepth) throw new Error("Catalog traversal depth exceeded");
    result.pageFiles.add(ref.file);
    const page = await this.readPage(ref);
    if (page.kind === "leaf") {
      result.segments.push(...page.entries);
      return;
    }
    for (const child of page.children) await this.collectReachablePage(child, result, depth + 1);
  }

  private async collectBefore(
    ref: CatalogPageRef,
    beforeSeq: number,
    limit: number,
    output: SegmentDescriptor[],
    depth = 0,
  ): Promise<void> {
    if (ref.minSeq >= beforeSeq || output.length >= limit) return;
    if (depth >= this.maxTraversalDepth) throw new Error("Catalog traversal depth exceeded");
    const page = await this.readPage(ref);
    const values = page.kind === "leaf" ? page.entries : page.children;
    for (let index = values.length - 1; index >= 0 && output.length < limit; index -= 1) {
      const value = values[index]!;
      if (value.minSeq >= beforeSeq) continue;
      if (page.kind === "leaf") output.push(value as SegmentDescriptor);
      else await this.collectBefore(value as CatalogPageRef, beforeSeq, limit, output, depth + 1);
    }
  }

  private async collectAfter(
    ref: CatalogPageRef,
    afterSeq: number,
    limit: number,
    output: SegmentDescriptor[],
    depth = 0,
  ): Promise<void> {
    if (ref.maxSeq <= afterSeq || output.length >= limit) return;
    if (depth >= this.maxTraversalDepth) throw new Error("Catalog traversal depth exceeded");
    const page = await this.readPage(ref);
    const values = page.kind === "leaf" ? page.entries : page.children;
    for (const value of values) {
      if (output.length >= limit) return;
      if (value.maxSeq <= afterSeq) continue;
      if (page.kind === "leaf") output.push(value as SegmentDescriptor);
      else await this.collectAfter(value as CatalogPageRef, afterSeq, limit, output, depth + 1);
    }
  }

  private async appendToPage(
    ref: CatalogPageRef,
    descriptor: SegmentDescriptor,
  ): Promise<CatalogPageRef[]> {
    const page = await this.readPage(ref);
    if (page.kind === "leaf") {
      return await this.writeSplitPages("leaf", [...page.entries, descriptor]);
    }
    const replacements = await this.appendToPage(page.children.at(-1)!, descriptor);
    return await this.writeSplitPages("internal", [...page.children.slice(0, -1), ...replacements]);
  }

  private async writeSplitPages(
    kind: "leaf",
    values: SegmentDescriptor[],
  ): Promise<CatalogPageRef[]>;
  private async writeSplitPages(
    kind: "internal",
    values: CatalogPageRef[],
  ): Promise<CatalogPageRef[]>;
  private async writeSplitPages(
    kind: "leaf" | "internal",
    values: SegmentDescriptor[] | CatalogPageRef[],
  ): Promise<CatalogPageRef[]> {
    if (values.length <= this.fanout) {
      return [
        await this.writePage(
          kind === "leaf"
            ? { version: 1, kind, entries: values as SegmentDescriptor[] }
            : { version: 1, kind, children: values as CatalogPageRef[] },
        ),
      ];
    }
    const middle = Math.ceil(values.length / 2);
    const left = values.slice(0, middle);
    const right = values.slice(middle);
    return await Promise.all([
      this.writePage(
        kind === "leaf"
          ? { version: 1, kind, entries: left as SegmentDescriptor[] }
          : { version: 1, kind, children: left as CatalogPageRef[] },
      ),
      this.writePage(
        kind === "leaf"
          ? { version: 1, kind, entries: right as SegmentDescriptor[] }
          : { version: 1, kind, children: right as CatalogPageRef[] },
      ),
    ]);
  }

  private async writePage(page: CatalogPage): Promise<CatalogPageRef> {
    validatePage(page, this.fanout);
    const summary = summarizePage(page);
    const text = JSON.stringify(page);
    if (Buffer.byteLength(text) > this.maxPageBytes) {
      throw new Error(`Catalog page exceeds the ${this.maxPageBytes}-byte limit`);
    }
    const file = `catalog-${randomUUID()}.json`;
    await this.writeAtomic(path.join(this.directory, file), text);
    return { file, minSeq: summary.minSeq, maxSeq: summary.maxSeq, summary };
  }

  private async readPage(ref: CatalogPageRef): Promise<CatalogPage> {
    validateCatalogRef(ref);
    const filePath = path.join(this.directory, ref.file);
    this.onPageRead?.(filePath);
    const page = validatePage(await readJsonFileCapped(filePath, this.maxPageBytes), this.fanout);
    const summary = summarizePage(page);
    if (
      summary.minSeq !== ref.minSeq ||
      summary.maxSeq !== ref.maxSeq ||
      JSON.stringify(summary) !== JSON.stringify(ref.summary)
    ) {
      throw new Error("Catalog page contents do not match their reference");
    }
    return page;
  }
}

function summarizePage(page: CatalogPage): TimelineSummary {
  const values = page.kind === "leaf" ? page.entries : page.children;
  if (values.length === 0) throw new Error("Catalog pages must not be empty");
  return values
    .slice(1)
    .reduce(
      (summary, value) => combineTimelineSummaries(summary, value.summary),
      values[0]!.summary,
    );
}

function validatePage(value: unknown, fanout: number): CatalogPage {
  if (!value || typeof value !== "object") throw new Error("Invalid catalog page");
  const candidate = value as {
    version?: unknown;
    kind?: unknown;
    entries?: unknown;
    children?: unknown;
  };
  if (candidate.version !== 1 || (candidate.kind !== "leaf" && candidate.kind !== "internal")) {
    throw new Error("Invalid catalog page");
  }
  const values = candidate.kind === "leaf" ? candidate.entries : candidate.children;
  if (!Array.isArray(values) || values.length < 1 || values.length > fanout) {
    throw new Error("Invalid catalog page fanout");
  }
  for (const entry of values) {
    if (candidate.kind === "leaf") validateDescriptor(entry);
    else validateCatalogRef(entry);
  }
  validateOrderedRanges(values as Array<{ minSeq: number; maxSeq: number }>);
  return candidate as CatalogPage;
}

function binaryFindRange(values: readonly CatalogPageRef[], seq: number): CatalogPageRef | null {
  let low = 0;
  let high = values.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const value = values[middle]!;
    if (seq < value.minSeq) high = middle - 1;
    else if (seq > value.maxSeq) low = middle + 1;
    else return value;
  }
  return null;
}
