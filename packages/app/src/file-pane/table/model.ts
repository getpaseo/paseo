export interface TableColumn {
  index: number;
  label: string;
}

export interface TableRow {
  index: number;
  cells: string[];
}

export interface TableGrid {
  columns: TableColumn[];
  rows: TableRow[];
}

export type TableSortDirection = "asc" | "desc";

export interface TableSort {
  column: number;
  direction: TableSortDirection;
}

/** Filter text per column index. A column with no entry is unfiltered. */
export type TableFilters = ReadonlyMap<number, string>;

interface TableViewInput {
  rows: TableRow[];
  filters: TableFilters;
  sort: TableSort | null;
}

interface TableFilterTerm {
  column: number;
  term: string;
}

// Ordered by how often a file in the wild uses them, which is also the tie-break
// order when the header row has the same count of two candidates.
const DELIMITERS = [",", "\t", ";", "|"];
const EXTENSION_DELIMITERS = [{ extension: ".tsv", delimiter: "\t" }];
const QUOTE = '"';

export function parseDelimitedTable(text: string, filePath = ""): TableGrid {
  const delimiter = detectDelimiter(text, namedDelimiter(filePath));
  const records = splitRecords(text, delimiter);
  if (records.length === 0) {
    return { columns: [], rows: [] };
  }

  const [header, ...body] = records;
  const width = Math.max(header.length, ...body.map((cells) => cells.length));
  const columns = Array.from({ length: width }, (_, index) => ({
    index,
    label: header[index] ?? "",
  }));
  const rows = body.map((cells, index) => ({
    index,
    cells: padCells(cells, width),
  }));

  return { columns, rows };
}

export function tableRowsInView({ rows, filters, sort }: TableViewInput): TableRow[] {
  const terms = filterTerms(filters);
  const matching = terms.length === 0 ? rows : rows.filter((row) => matchesTerms(row, terms));
  if (!sort) return matching;

  const direction = sort.direction === "asc" ? 1 : -1;
  return [...matching].sort((left, right) => {
    const leftCell = left.cells[sort.column];
    const rightCell = right.cells[sort.column];
    // Blank cells stay at the bottom in both directions, so flipping the
    // direction reorders values without pulling the gaps to the top.
    const blankOrder = Number(isBlank(leftCell)) - Number(isBlank(rightCell));
    if (blankOrder !== 0) return blankOrder;
    const order = compareCells(leftCell, rightCell) * direction;
    return order === 0 ? left.index - right.index : order;
  });
}

export function nextTableSort(current: TableSort | null, column: number): TableSort | null {
  if (current?.column !== column) return { column, direction: "asc" };
  if (current.direction === "asc") return { column, direction: "desc" };
  return null;
}

function filterTerms(filters: TableFilters): TableFilterTerm[] {
  const terms: TableFilterTerm[] = [];
  for (const [column, value] of filters) {
    const term = value.trim().toLowerCase();
    if (term.length > 0) terms.push({ column, term });
  }
  return terms;
}

function matchesTerms(row: TableRow, terms: TableFilterTerm[]): boolean {
  return terms.every(({ column, term }) => row.cells[column].toLowerCase().includes(term));
}

function isBlank(cell: string): boolean {
  return cell.trim().length === 0;
}

// A spreadsheet sorts 10 after 9 and "Ada" next to "ada"; the engine's default
// string compare does neither. Locale-aware compare is avoided on purpose:
// Hermes, JSC, and V8 disagree, and the same file must sort the same on every
// platform.
const NUMERIC_CELL = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

function compareCells(left: string, right: string): number {
  const leftNumber = numericCell(left);
  const rightNumber = numericCell(right);
  if (leftNumber !== null && rightNumber !== null) {
    return leftNumber - rightNumber;
  }
  const folded = compareStrings(left.toLowerCase(), right.toLowerCase());
  return folded === 0 ? compareStrings(left, right) : folded;
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

function numericCell(cell: string): number | null {
  const trimmed = cell.trim();
  if (!NUMERIC_CELL.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

function padCells(cells: string[], width: number): string[] {
  if (cells.length === width) return cells;
  return Array.from({ length: width }, (_, index) => cells[index] ?? "");
}

// An extension that names its delimiter wins whenever that delimiter is present:
// a .tsv header holding "last, first" has as many commas as tabs, and counting
// alone would split the name in half.
function namedDelimiter(filePath: string): string | null {
  const normalizedPath = filePath.trim().toLowerCase();
  const named = EXTENSION_DELIMITERS.find((entry) => normalizedPath.endsWith(entry.extension));
  return named ? named.delimiter : null;
}

function detectDelimiter(text: string, named: string | null): string {
  const header = headerRecord(text);
  if (named && countUnquoted(header, named) > 0) {
    return named;
  }

  let best = DELIMITERS[0];
  let bestCount = 0;
  for (const candidate of DELIMITERS) {
    const count = countUnquoted(header, candidate);
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

// The header row alone decides the delimiter: a data cell holding prose can
// out-count the real delimiter, a header cell almost never does.
function headerRecord(text: string): string {
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === QUOTE) {
      quoted = !quoted;
      continue;
    }
    if (!quoted && (char === "\n" || char === "\r")) {
      return text.slice(0, index);
    }
  }
  return text;
}

function countUnquoted(record: string, delimiter: string): number {
  let count = 0;
  let quoted = false;
  for (const char of record) {
    if (char === QUOTE) {
      quoted = !quoted;
      continue;
    }
    if (!quoted && char === delimiter) count += 1;
  }
  return count;
}

function splitRecords(text: string, delimiter: string): string[][] {
  const records: string[][] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  // A blank line is a separator; a line of empty cells is data. They both parse
  // to empty strings, so the difference has to be caught while reading: a
  // delimiter, a quote, or any character means the line said something.
  let written = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char !== QUOTE) {
        cell += char;
        continue;
      }
      if (text[index + 1] === QUOTE) {
        cell += QUOTE;
        index += 1;
        continue;
      }
      quoted = false;
      continue;
    }
    // A quote only opens a quoted cell at the start of that cell, so a stray
    // quote inside an unquoted value stays literal instead of swallowing the
    // rest of the file.
    if (char === QUOTE && cell.length === 0) {
      quoted = true;
      written = true;
      continue;
    }
    if (char === delimiter) {
      cells.push(cell);
      cell = "";
      written = true;
      continue;
    }
    if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index += 1;
      if (written) {
        cells.push(cell);
        records.push(cells);
      }
      cells = [];
      cell = "";
      written = false;
      continue;
    }
    cell += char;
    written = true;
  }

  if (written) {
    cells.push(cell);
    records.push(cells);
  }

  return records;
}
