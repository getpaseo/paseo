import type { ParsedDiffFile } from "@/git/use-diff-query";
import {
  buildDiffTree,
  compressSingleChildChains,
  flattenDiffTree,
  type DiffTreeDirNode,
} from "@/git/diff-tree";
import {
  buildSplitDiffRows,
  buildUnifiedDiffLines,
  type ReviewableDiffTarget,
  type SplitDiffRow,
  type UnifiedDiffDisplayLine,
} from "@/utils/diff-layout";

// Tune cell size and the outer list window together. On the 1,200-row fixture, the exact
// three-fling repro filled immediately with both 32/720 + window 21 and this lower-cost pair
// on an iPhone 17 Pro simulator. Simulator frame percentiles are unavailable in xctrace.
export const DIFF_VIRTUALIZATION_CONFIG = {
  groupRowLimit: 16,
  groupHeightLimit: 360,
  initialNumToRender: 8,
  maxToRenderPerBatch: 8,
  updateCellsBatchingPeriod: 16,
  windowSize: 10,
} as const;

interface FolderItem {
  type: "folder";
  dirPath: string;
  displayName: string;
  depth: number;
  collapsed: boolean;
  additions: number;
  deletions: number;
}

interface HeaderItem {
  type: "header";
  file: ParsedDiffFile;
  fileIndex: number;
  isExpanded: boolean;
  depth: number;
}

interface StatusItem {
  type: "status";
  file: ParsedDiffFile;
  fileIndex: number;
  depth: number;
}

interface RowGroupBase {
  file: ParsedDiffFile;
  fileIndex: number;
  depth: number;
  groupIndex: number;
  startRowIndex: number;
  isFirst: boolean;
  isLast: boolean;
  contentColumns: number;
  key: string;
}

export interface UnifiedRowGroupItem extends RowGroupBase {
  type: "unified_group";
  lines: UnifiedDiffDisplayLine[];
}

export interface SplitRowGroupItem extends RowGroupBase {
  type: "split_group";
  rows: SplitDiffRow[];
}

export type DiffListItem =
  | FolderItem
  | HeaderItem
  | StatusItem
  | UnifiedRowGroupItem
  | SplitRowGroupItem;

export interface DiffRowIndex {
  items: DiffListItem[];
  stickyHeaderIndices: number[];
  heightAt: (index: number) => number;
  offsetAt: (index: number) => number;
  offsetOfFile: (path: string) => number;
  indexOfFile: (path: string) => number;
  indexOfGroup: (key: string) => number;
  updateHeight: (
    key: string,
    height: number,
  ) => { delta: number; index: number; previousHeight: number } | null;
  totalHeight: number;
}

export interface DiffRowCache {
  unifiedFor: (file: ParsedDiffFile) => UnifiedDiffDisplayLine[];
  splitFor: (file: ParsedDiffFile) => SplitDiffRow[];
}

export function createDiffRowCache(): DiffRowCache {
  const unified = new WeakMap<ParsedDiffFile, UnifiedDiffDisplayLine[]>();
  const split = new WeakMap<ParsedDiffFile, SplitDiffRow[]>();
  return {
    unifiedFor(file) {
      const cached = unified.get(file);
      if (cached) return cached;
      const lines = buildUnifiedDiffLines(file);
      unified.set(file, lines);
      return lines;
    },
    splitFor(file) {
      const cached = split.get(file);
      if (cached) return cached;
      const rows = buildSplitDiffRows(file);
      split.set(file, rows);
      return rows;
    },
  };
}

const defaultRowCache = createDiffRowCache();

export interface BuildDiffRowIndexInput {
  files: ParsedDiffFile[];
  viewMode: "flat" | "tree";
  collapsedFolders: ReadonlySet<string>;
  expandedPaths: ReadonlySet<string>;
  layout: "unified" | "split";
  wrapLines: boolean;
  lineHeight: number;
  viewportWidth: number;
  codeFontSize: number;
  headerHeightFor: (file: ParsedDiffFile) => number;
  folderHeight: number;
  statusHeight: number;
  measuredGroupHeights: ReadonlyMap<string, number>;
  geometryKey: string;
  reviewHeightFor: (target: ReviewableDiffTarget | null | undefined) => number;
  rowCache?: DiffRowCache;
  tree?: DiffTreeDirNode;
}

interface PendingGroup<Row> {
  rows: Row[];
  startRowIndex: number;
  height: number;
}

function displayColumns(content: string): number {
  let columns = 0;
  for (const character of content) {
    columns = character === "\t" ? columns + (4 - (columns % 4)) : columns + 1;
  }
  return columns;
}

function estimatedVisualLines(content: string, columns: number): number {
  return Math.max(1, Math.ceil(displayColumns(content) / columns));
}

function groupRows<Row>(rows: Row[], heightFor: (row: Row) => number): PendingGroup<Row>[] {
  const groups: PendingGroup<Row>[] = [];
  let current: PendingGroup<Row> = { rows: [], startRowIndex: 0, height: 0 };

  for (const [rowIndex, row] of rows.entries()) {
    const rowHeight = heightFor(row);
    const reachedRowLimit = current.rows.length >= DIFF_VIRTUALIZATION_CONFIG.groupRowLimit;
    const reachedHeightLimit =
      current.rows.length > 0 &&
      current.height + rowHeight > DIFF_VIRTUALIZATION_CONFIG.groupHeightLimit;
    if (reachedRowLimit || reachedHeightLimit) {
      groups.push(current);
      current = { rows: [], startRowIndex: rowIndex, height: 0 };
    }
    current.rows.push(row);
    current.height += rowHeight;
  }

  if (current.rows.length > 0) {
    groups.push(current);
  }
  return groups;
}

function contentColumnsForUnified(lines: UnifiedDiffDisplayLine[]): number {
  return lines.reduce((longest, line) => Math.max(longest, displayColumns(line.line.content)), 0);
}

function contentColumnsForSplit(rows: SplitDiffRow[]): number {
  return rows.reduce((longest, row) => {
    if (row.kind === "header") {
      return Math.max(longest, displayColumns(row.content));
    }
    return Math.max(
      longest,
      displayColumns(row.left?.content ?? ""),
      displayColumns(row.right?.content ?? ""),
    );
  }, 0);
}

function availableTextColumns(input: BuildDiffRowIndexInput): number {
  const viewportWidth = Math.round(input.viewportWidth);
  const columnWidth = input.layout === "split" ? viewportWidth / 2 : viewportWidth;
  const characterWidth = input.codeFontSize * 0.62;
  return Math.max(8, Math.floor((columnWidth - 72) / characterWidth));
}

export function buildDiffRowIndex(input: BuildDiffRowIndexInput): DiffRowIndex {
  const items: DiffListItem[] = [];
  const heights: number[] = [];
  const stickyHeaderIndices: number[] = [];
  const fileIndexByPath = new Map<string, number>();
  const groupIndexByKey = new Map<string, number>();
  const availableColumns = availableTextColumns(input);
  const rowCache = input.rowCache ?? defaultRowCache;

  function push(item: DiffListItem, height: number): void {
    if (item.type === "unified_group" || item.type === "split_group") {
      groupIndexByKey.set(item.key, items.length);
    }
    items.push(item);
    heights.push(height);
  }

  function pushUnifiedGroups(file: ParsedDiffFile, fileIndex: number, depth: number): void {
    const lines = rowCache.unifiedFor(file);
    const contentColumns = contentColumnsForUnified(lines);
    const groups = groupRows(lines, (line) => {
      const visualLines = input.wrapLines
        ? estimatedVisualLines(line.line.content, availableColumns)
        : 1;
      return visualLines * input.lineHeight + input.reviewHeightFor(line.reviewTarget);
    });

    for (const [groupIndex, group] of groups.entries()) {
      const isFirst = groupIndex === 0;
      const isLast = groupIndex === groups.length - 1;
      const key = `${input.geometryKey}:${file.path}:unified:${group.startRowIndex}`;
      const estimatedHeight = group.height + (isFirst ? 1 : 0) + (isLast ? 1 : 0);
      push(
        {
          type: "unified_group",
          file,
          fileIndex,
          depth,
          groupIndex,
          startRowIndex: group.startRowIndex,
          isFirst,
          isLast,
          contentColumns,
          key,
          lines: group.rows,
        },
        input.measuredGroupHeights.get(key) ?? estimatedHeight,
      );
    }
  }

  function pushSplitGroups(file: ParsedDiffFile, fileIndex: number, depth: number): void {
    const rows = rowCache.splitFor(file);
    const contentColumns = contentColumnsForSplit(rows);
    const groups = groupRows(rows, (row) => {
      if (row.kind === "header") {
        const visualLines = input.wrapLines
          ? estimatedVisualLines(row.content, availableColumns)
          : 1;
        return visualLines * input.lineHeight;
      }
      const visualLines = input.wrapLines
        ? Math.max(
            estimatedVisualLines(row.left?.content ?? "", availableColumns),
            estimatedVisualLines(row.right?.content ?? "", availableColumns),
          )
        : 1;
      const reviewHeight = Math.max(
        input.reviewHeightFor(row.left?.reviewTarget),
        input.reviewHeightFor(row.right?.reviewTarget),
      );
      return visualLines * input.lineHeight + reviewHeight;
    });

    for (const [groupIndex, group] of groups.entries()) {
      const isFirst = groupIndex === 0;
      const isLast = groupIndex === groups.length - 1;
      const key = `${input.geometryKey}:${file.path}:split:${group.startRowIndex}`;
      const estimatedHeight = group.height + (isFirst ? 1 : 0) + (isLast ? 1 : 0);
      push(
        {
          type: "split_group",
          file,
          fileIndex,
          depth,
          groupIndex,
          startRowIndex: group.startRowIndex,
          isFirst,
          isLast,
          contentColumns,
          key,
          rows: group.rows,
        },
        input.measuredGroupHeights.get(key) ?? estimatedHeight,
      );
    }
  }

  function pushFile(file: ParsedDiffFile, fileIndex: number, depth: number): void {
    const isExpanded = input.expandedPaths.has(file.path);
    const headerIndex = items.length;
    fileIndexByPath.set(file.path, headerIndex);
    push({ type: "header", file, fileIndex, isExpanded, depth }, input.headerHeightFor(file));
    if (!isExpanded) {
      return;
    }
    stickyHeaderIndices.push(headerIndex);
    if (file.status === "binary" || file.status === "too_large") {
      push({ type: "status", file, fileIndex, depth }, input.statusHeight);
      return;
    }
    if (input.layout === "split") {
      pushSplitGroups(file, fileIndex, depth);
      return;
    }
    pushUnifiedGroups(file, fileIndex, depth);
  }

  if (input.viewMode === "flat") {
    for (const [fileIndex, file] of input.files.entries()) {
      pushFile(file, fileIndex, 0);
    }
  } else {
    const indexByPath = new Map(input.files.map((file, index) => [file.path, index]));
    const tree = input.tree ?? compressSingleChildChains(buildDiffTree(input.files));
    for (const row of flattenDiffTree(tree, input.collapsedFolders)) {
      if (row.kind === "folder") {
        push(
          {
            type: "folder",
            dirPath: row.dirPath,
            displayName: row.displayName,
            depth: row.depth,
            collapsed: input.collapsedFolders.has(row.dirPath),
            additions: row.additions,
            deletions: row.deletions,
          },
          input.folderHeight,
        );
        continue;
      }
      const fileIndex = indexByPath.get(row.file.path);
      if (fileIndex !== undefined) {
        pushFile(row.file, fileIndex, row.depth);
      }
    }
  }

  const offsets = Array.from({ length: items.length + 1 }, () => 0);
  for (let index = 0; index < items.length; index += 1) {
    offsets[index + 1] = offsets[index] + heights[index];
  }

  return {
    items,
    stickyHeaderIndices,
    heightAt: (index) => heights[index] ?? 0,
    offsetAt: (index) => offsets[Math.max(0, Math.min(index, items.length))],
    offsetOfFile: (path) => offsets[fileIndexByPath.get(path) ?? 0],
    indexOfFile: (path) => fileIndexByPath.get(path) ?? -1,
    indexOfGroup: (key) => groupIndexByKey.get(key) ?? -1,
    updateHeight: (key, height) => {
      const index = groupIndexByKey.get(key);
      if (index === undefined || !Number.isFinite(height) || height < 0) {
        return null;
      }
      const previousHeight = heights[index];
      const delta = height - previousHeight;
      if (delta === 0) {
        return { delta, index, previousHeight };
      }
      heights[index] = height;
      for (let offsetIndex = index + 1; offsetIndex < offsets.length; offsetIndex += 1) {
        offsets[offsetIndex] += delta;
      }
      return { delta, index, previousHeight };
    },
    get totalHeight() {
      return offsets[items.length];
    },
  };
}
