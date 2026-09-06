import { expect, test } from "vitest";
import { preselectLocalFiles, type ImportRow } from "./form";

function candidate(path: string, size: number, existing = false): ImportRow {
  return {
    path,
    size,
    sourceStatus: "ready",
    status: "ready",
    selected: false,
    error: null,
    destination: {
      path,
      status: existing ? "ready" : "missing",
      size: existing ? size : 0,
      revision: existing ? "existing" : null,
    },
  };
}

test("preselection respects the aggregate budget and never opts into replacement or a large file", () => {
  const mib = 1024 * 1024;
  const rows = preselectLocalFiles([
    candidate(".env.existing", 20, true),
    candidate(".env.large", 2 * mib),
    ...Array.from({ length: 11 }, (_, index) => candidate(".env." + index, mib)),
  ]);
  expect(rows.slice(0, 2).every((row) => !row.selected)).toBe(true);
  expect(rows.filter((row) => row.selected).map((row) => row.path)).toEqual(
    Array.from({ length: 10 }, (_, index) => ".env." + index),
  );
  expect(rows.at(-1)?.selected).toBe(false);
});
