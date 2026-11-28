import { expect, test } from "vitest";
import { DiffStream } from "./stream.js";
import { DiffOpcode, type DiffBegin } from "@getpaseo/protocol/binary-frames/index";
import type { DiffState } from "./index.js";
const entry = {
  path: "a.ts",
  oldPath: null,
  change: "modified" as const,
  content: "text" as const,
  additions: 1,
  deletions: 0,
  body: true,
};
const begin = (revision: number, baseRevision = 0): DiffBegin => ({
  opcode: DiffOpcode.Begin,
  slot: 0,
  revision,
  baseRevision,
  baseSha: "a",
  headSha: "b",
  mergeBaseSha: "",
  entries: [entry],
});
const end = (revision: number) =>
  ({
    opcode: DiffOpcode.End,
    slot: 0,
    revision,
    diffTooLarge: false,
    omitted: [],
    error: null,
  }) as const;
test("publishes the initial tree, commits on End and buffers refreshes with stable equal files", () => {
  const states: DiffState[] = [];
  const stream = new DiffStream((state) => states.push(state));
  stream.receive(begin(1));
  expect(states[0]).toMatchObject({ phase: "loading", entries: [{ path: "a.ts" }] });
  stream.receive({
    opcode: DiffOpcode.Bodies,
    slot: 0,
    revision: 1,
    files: [{ path: "a.ts", hunks: [] }],
  });
  expect(states).toHaveLength(1);
  stream.receive(end(1));
  const ready = states[1];
  if (ready.phase !== "ready") throw new Error("Expected ready");
  stream.receive(begin(2, 1));
  stream.receive({
    opcode: DiffOpcode.Bodies,
    slot: 0,
    revision: 2,
    files: [{ path: "a.ts", hunks: [] }],
  });
  expect(states).toHaveLength(2);
  stream.receive(end(2));
  const refreshed = states[2];
  if (refreshed.phase !== "ready") throw new Error("Expected ready");
  expect(refreshed.files[0]).toBe(ready.files[0]);
});
test("superseded and stale frames cannot leave the client loading; End is authoritative", () => {
  const states: DiffState[] = [];
  const stream = new DiffStream((s) => states.push(s));
  stream.receive(begin(1));
  stream.receive(begin(2));
  stream.receive(end(1));
  expect(() => stream.receive(end(2))).toThrow(/Missing/);
  stream.receive(begin(3));
  stream.receive({ ...end(3), error: { code: "REF_NOT_FOUND", message: "gone" } });
  expect(states.at(-1)).toMatchObject({ phase: "error", error: { code: "REF_NOT_FOUND" } });
  stream.receive({ ...begin(4), entries: [] });
  stream.receive(end(4));
  expect(states.at(-1)).toMatchObject({ phase: "ready", files: [] });
});
test("unchanged entries retain hunks, omissions override cache, removed paths disappear", () => {
  const states: DiffState[] = [];
  const stream = new DiffStream((s) => states.push(s));
  stream.receive(begin(1));
  stream.receive({ ...end(1), omitted: ["a.ts"], diffTooLarge: true });
  stream.receive({ ...begin(2, 1), entries: [{ ...entry, body: false }] });
  stream.receive(end(2));
  expect(states.at(-1)).toMatchObject({ phase: "ready", files: [{ status: "too_large" }] });
  stream.receive({ ...begin(3, 2), entries: [] });
  stream.receive(end(3));
  expect(states.at(-1)).toMatchObject({ phase: "ready", files: [] });
});
