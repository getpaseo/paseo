import { describe, expect, it } from "vitest";
import {
  nextTableSort,
  parseDelimitedTable,
  tableRowsInView,
  tableViewWithinColumns,
  type TableRow,
  type TableSort,
} from "./model";

describe("parseDelimitedTable", () => {
  it("reads the first row as column labels and the rest as rows", () => {
    const table = parseDelimitedTable("name,age\nada,36\ngrace,45\n");

    expect(table.columns).toEqual([
      { index: 0, label: "name" },
      { index: 1, label: "age" },
    ]);
    expect(table.rows).toEqual([
      { index: 0, cells: ["ada", "36"] },
      { index: 1, cells: ["grace", "45"] },
    ]);
  });

  it("keeps delimiters, newlines, and doubled quotes inside a quoted field", () => {
    const table = parseDelimitedTable('note,owner\n"a, b\nc","say ""hi"""\n');

    expect(table.rows).toEqual([{ index: 0, cells: ["a, b\nc", 'say "hi"'] }]);
  });

  it("detects the delimiter from the header row", () => {
    expect(parseDelimitedTable("a\tb\n1\t2").columns.map((column) => column.label)).toEqual([
      "a",
      "b",
    ]);
    expect(parseDelimitedTable("a;b\n1;2").columns.map((column) => column.label)).toEqual([
      "a",
      "b",
    ]);
    expect(parseDelimitedTable("a|b\n1|2").columns.map((column) => column.label)).toEqual([
      "a",
      "b",
    ]);
  });

  it("ignores delimiters that only appear inside a quoted header cell", () => {
    const table = parseDelimitedTable('"last, first";age\n"lovelace, ada";36');

    expect(table.columns.map((column) => column.label)).toEqual(["last, first", "age"]);
    expect(table.rows).toEqual([{ index: 0, cells: ["lovelace, ada", "36"] }]);
  });

  it("pads ragged rows to the widest row and labels the extra columns", () => {
    const table = parseDelimitedTable("a,b\n1\n2,3,4");

    expect(table.columns).toEqual([
      { index: 0, label: "a" },
      { index: 1, label: "b" },
      { index: 2, label: "" },
    ]);
    expect(table.rows).toEqual([
      { index: 0, cells: ["1", "", ""] },
      { index: 1, cells: ["2", "3", "4"] },
    ]);
  });

  it("splits a .tsv file on tabs even when the header also holds a comma", () => {
    const table = parseDelimitedTable("last, first\tage\nlovelace, ada\t36", "people.tsv");

    expect(table.columns.map((column) => column.label)).toEqual(["last, first", "age"]);
    expect(table.rows).toEqual([{ index: 0, cells: ["lovelace, ada", "36"] }]);
  });

  it("keeps a .tsv single column whose text contains commas", () => {
    const table = parseDelimitedTable("description, notes\nhello, world\n", "notes.tsv");

    expect(table.columns.map((column) => column.label)).toEqual(["description, notes"]);
    expect(table.rows).toEqual([{ index: 0, cells: ["hello, world"] }]);
  });

  it("still sniffs the delimiter when the extension does not name one", () => {
    const table = parseDelimitedTable("a;b\n1;2", "data.csv");

    expect(table.columns.map((column) => column.label)).toEqual(["a", "b"]);
  });

  it("keeps a row whose cells are all empty", () => {
    const table = parseDelimitedTable("a,b\n,\n1,2");

    expect(table.rows).toEqual([
      { index: 0, cells: ["", ""] },
      { index: 1, cells: ["1", "2"] },
    ]);
  });

  it("keeps a row holding a single quoted empty cell", () => {
    const table = parseDelimitedTable('value\n""\nkept');

    expect(table.rows).toEqual([
      { index: 0, cells: [""] },
      { index: 1, cells: ["kept"] },
    ]);
  });

  it("drops blank lines between records", () => {
    const table = parseDelimitedTable("a,b\n1,2\n\n3,4\n");

    expect(table.rows).toEqual([
      { index: 0, cells: ["1", "2"] },
      { index: 1, cells: ["3", "4"] },
    ]);
  });

  it("accepts CRLF line endings and a trailing newline", () => {
    const table = parseDelimitedTable("a,b\r\n1,2\r\n");

    expect(table.rows).toEqual([{ index: 0, cells: ["1", "2"] }]);
  });

  it("returns an empty table for blank content", () => {
    expect(parseDelimitedTable("")).toEqual({ columns: [], rows: [] });
    expect(parseDelimitedTable("\n")).toEqual({ columns: [], rows: [] });
  });

  it("keeps a header-only file as columns with no rows", () => {
    const table = parseDelimitedTable("a,b\n");

    expect(table.columns.map((column) => column.label)).toEqual(["a", "b"]);
    expect(table.rows).toEqual([]);
  });
});

function rowsOf(...cells: string[][]): TableRow[] {
  return cells.map((values, index) => ({ index, cells: values }));
}

function labelsOf(rows: TableRow[]): string[] {
  return rows.map((row) => row.cells[0]);
}

describe("tableRowsInView", () => {
  const rows = rowsOf(
    ["Ada", "36", "London"],
    ["Grace", "45", "New York"],
    ["alan", "41", "london"],
  );

  it("returns every row when nothing is filtered or sorted", () => {
    expect(tableRowsInView({ rows, filters: new Map(), sort: null })).toEqual(rows);
  });

  it("filters case-insensitively on a substring", () => {
    const view = tableRowsInView({ rows, filters: new Map([[2, "LON"]]), sort: null });

    expect(labelsOf(view)).toEqual(["Ada", "alan"]);
  });

  it("requires every column filter to match", () => {
    const view = tableRowsInView({
      rows,
      filters: new Map([
        [2, "london"],
        [0, "ada"],
      ]),
      sort: null,
    });

    expect(labelsOf(view)).toEqual(["Ada"]);
  });

  it("ignores a filter that is only whitespace", () => {
    expect(tableRowsInView({ rows, filters: new Map([[0, "  "]]), sort: null })).toEqual(rows);
  });

  it("sorts numeric columns by value, not by digits", () => {
    const numbers = rowsOf(["9"], ["10"], ["-2.5"]);
    const view = tableRowsInView({
      rows: numbers,
      filters: new Map(),
      sort: { column: 0, direction: "asc" },
    });

    expect(labelsOf(view)).toEqual(["-2.5", "9", "10"]);
  });

  it("sorts text case-insensitively and reverses on descending", () => {
    const ascending = tableRowsInView({
      rows,
      filters: new Map(),
      sort: { column: 0, direction: "asc" },
    });
    const descending = tableRowsInView({
      rows,
      filters: new Map(),
      sort: { column: 0, direction: "desc" },
    });

    expect(labelsOf(ascending)).toEqual(["Ada", "alan", "Grace"]);
    expect(labelsOf(descending)).toEqual(["Grace", "alan", "Ada"]);
  });

  it("keeps blank cells last in both directions", () => {
    const sparse = rowsOf(["b"], [""], ["a"]);
    const ascending = tableRowsInView({
      rows: sparse,
      filters: new Map(),
      sort: { column: 0, direction: "asc" },
    });
    const descending = tableRowsInView({
      rows: sparse,
      filters: new Map(),
      sort: { column: 0, direction: "desc" },
    });

    expect(labelsOf(ascending)).toEqual(["a", "b", ""]);
    expect(labelsOf(descending)).toEqual(["b", "a", ""]);
  });

  it("keeps equal cells in file order", () => {
    const duplicates = rowsOf(["same", "second"], ["same", "first"]);
    const view = tableRowsInView({
      rows: duplicates,
      filters: new Map(),
      sort: { column: 0, direction: "desc" },
    });

    expect(view.map((row) => row.cells[1])).toEqual(["second", "first"]);
  });

  it("leaves the source rows untouched", () => {
    const original = [...rows];
    tableRowsInView({ rows, filters: new Map(), sort: { column: 1, direction: "desc" } });

    expect(rows).toEqual(original);
  });
});

describe("tableViewWithinColumns", () => {
  it("keeps a sort and filters that still have columns", () => {
    const sort: TableSort = { column: 1, direction: "asc" };
    const filters = new Map([[0, "ada"]]);

    const view = tableViewWithinColumns({ sort, filters }, 2);

    expect(view.sort).toBe(sort);
    expect(view.filters).toBe(filters);
  });

  it("drops a sort whose column the file no longer has", () => {
    const view = tableViewWithinColumns(
      { sort: { column: 2, direction: "desc" }, filters: new Map() },
      2,
    );

    expect(view.sort).toBe(null);
  });

  it("drops filters past the last column and keeps the rest", () => {
    const view = tableViewWithinColumns(
      {
        sort: null,
        filters: new Map([
          [0, "ada"],
          [3, "gone"],
        ]),
      },
      2,
    );

    expect([...view.filters]).toEqual([[0, "ada"]]);
  });

  it("drops everything when the file has no columns", () => {
    const view = tableViewWithinColumns(
      { sort: { column: 0, direction: "asc" }, filters: new Map([[0, "ada"]]) },
      0,
    );

    expect(view.sort).toBe(null);
    expect([...view.filters]).toEqual([]);
  });
});

describe("nextTableSort", () => {
  it("cycles a column through ascending, descending, and unsorted", () => {
    const ascending = nextTableSort(null, 2);
    expect(ascending).toEqual({ column: 2, direction: "asc" });

    const descending = nextTableSort(ascending, 2);
    expect(descending).toEqual({ column: 2, direction: "desc" });

    expect(nextTableSort(descending, 2)).toBe(null);
  });

  it("starts a different column ascending", () => {
    expect(nextTableSort({ column: 0, direction: "desc" }, 1)).toEqual({
      column: 1,
      direction: "asc",
    });
  });
});
