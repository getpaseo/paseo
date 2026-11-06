import { expect, test } from "vitest";
import { decodeDiffFrame, encodeDiffFrame } from "./diff.js";
import { decodeBinaryFrame } from "./demux.js";
import { decodePluginFrame } from "./plugin.js";

test("routes diff revisions independently of plugin frames", () => {
  const frame = {
    opcode: 0x40 as const,
    slot: 0,
    revision: 1,
    baseRevision: 0,
    baseSha: "",
    headSha: "",
    mergeBaseSha: "",
    entries: [],
  };
  const bytes = encodeDiffFrame(frame);
  expect([...bytes]).toEqual([64, 0, 1, 1, 0, 0, 0, 0, 0]);
  expect(decodeDiffFrame(bytes)).toEqual(frame);
  expect(decodeBinaryFrame(bytes)).toEqual({ kind: "diff", frame });
  expect(decodePluginFrame(bytes)).toBeNull();
});

test("roundtrips Unicode runs and materializes the existing file shape", async () => {
  const { materializeDiffFile } = await import("./diff.js");
  const frame = {
    opcode: 0x41 as const,
    slot: 255,
    revision: 128,
    files: [
      {
        path: "é.ts",
        hunks: [
          {
            oldStart: 1,
            oldCount: 1,
            newStart: 1,
            newCount: 1,
            lines: [
              {
                type: "add" as const,
                content: "😀é",
                runs: [
                  { style: "string", length: 2 },
                  { style: null, length: 2 },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
  expect(decodeDiffFrame(encodeDiffFrame(frame))).toEqual(frame);
  const file = materializeDiffFile(
    {
      path: "é.ts",
      oldPath: null,
      change: "modified",
      content: "text",
      additions: 1,
      deletions: 1,
      body: true,
    },
    frame.files[0],
    false,
  );
  expect(file.hunks[0].lines[0].tokens).toEqual([
    { text: "😀", style: "string" },
    { text: "é", style: null },
  ]);
});

test("preserves binary additions, modifications, deletions and mode-only text", async () => {
  const { materializeDiffFile } = await import("./diff.js");
  for (const change of ["added", "modified", "deleted"] as const) {
    const entry = {
      path: "image.png",
      oldPath: null,
      change,
      content: "binary" as const,
      additions: 0,
      deletions: 0,
      body: false,
    };
    const begin = {
      opcode: 0x40 as const,
      slot: 1,
      revision: 1,
      baseRevision: 0,
      baseSha: "",
      headSha: "",
      mergeBaseSha: "",
      entries: [entry],
    };
    expect(decodeDiffFrame(encodeDiffFrame(begin))).toEqual(begin);
    expect(materializeDiffFile(entry, null, false)).toEqual({
      path: "image.png",
      isNew: change === "added",
      isDeleted: change === "deleted",
      additions: 0,
      deletions: 0,
      status: "binary",
      hunks: [],
    });
  }
  expect(
    materializeDiffFile(
      {
        path: "script",
        oldPath: null,
        change: "modified",
        content: "text",
        additions: 0,
        deletions: 0,
        body: true,
      },
      { path: "script", hunks: [] },
      false,
    ),
  ).toEqual({
    path: "script",
    isNew: false,
    isDeleted: false,
    additions: 0,
    deletions: 0,
    status: "ok",
    hunks: [],
  });
});

test("rejects every truncated prefix, unknown version, trailing data, and invalid coverage", () => {
  const end = {
    opcode: 0x42 as const,
    slot: 1,
    revision: 9007199254740991,
    diffTooLarge: true,
    omitted: ["a.ts"],
    error: { code: "REF_NOT_FOUND" as const, message: "missing" },
  };
  const bytes = encodeDiffFrame(end);
  expect(decodeDiffFrame(bytes)).toEqual(end);
  for (let length = 0; length < bytes.length; length++)
    expect(() => decodeDiffFrame(bytes.slice(0, length))).toThrow();
  const version = bytes.slice();
  version[2] = 2;
  expect(() => decodeDiffFrame(version)).toThrow("version");
  expect(() => decodeDiffFrame(Uint8Array.from([...bytes, 0]))).toThrow("Trailing");
  expect(() =>
    encodeDiffFrame({
      opcode: 0x41,
      slot: 1,
      revision: 1,
      files: [
        {
          path: "x",
          hunks: [
            {
              oldStart: 0,
              oldCount: 0,
              newStart: 1,
              newCount: 1,
              lines: [{ type: "add", content: "😀", runs: [{ style: null, length: 1 }] }],
            },
          ],
        },
      ],
    }),
  ).toThrow("cover");
});

test("uses fixed UTF-8 byte vectors while runs count UTF-16 units", () => {
  const bytes = Uint8Array.from([
    65, 0, 1, 1, 1, 1, 120, 1, 0, 0, 1, 1, 1, 129, 7, 240, 159, 152, 128, 101, 204, 129, 1, 3, 4,
  ]);
  const frame = {
    opcode: 0x41 as const,
    slot: 0,
    revision: 1,
    files: [
      {
        path: "x",
        hunks: [
          {
            oldStart: 0,
            oldCount: 0,
            newStart: 1,
            newCount: 1,
            lines: [
              { type: "add" as const, content: "😀é", runs: [{ style: "string", length: 4 }] },
            ],
          },
        ],
      },
    ],
  };
  expect(encodeDiffFrame(frame)).toEqual(bytes);
  expect(decodeDiffFrame(bytes)).toEqual(frame);
  const unknownStyle = bytes.slice();
  unknownStyle[23] = 255;
  expect(decodeDiffFrame(unknownStyle)).toEqual({
    ...frame,
    files: [
      {
        ...frame.files[0],
        hunks: [
          {
            ...frame.files[0].hunks[0],
            lines: [{ type: "add", content: "😀é", runs: [{ style: null, length: 4 }] }],
          },
        ],
      },
    ],
  });
});

test("roundtrips generated entry lists across varint boundaries", () => {
  for (const revision of [0, 1, 127, 128, 16383, 16384, 4294967296, Number.MAX_SAFE_INTEGER]) {
    const entries = Array.from({ length: 130 }, (_, index) => ({
      path: `src/${index}-😀.ts`,
      oldPath: `old/${index}.ts`,
      change: "renamed" as const,
      content: "text" as const,
      additions: index * 128,
      deletions: index,
      body: true,
    }));
    const begin = {
      opcode: 0x40 as const,
      slot: 255,
      revision,
      baseRevision: 0,
      baseSha: "base",
      headSha: "head",
      mergeBaseSha: "merge",
      entries,
    };
    expect(decodeDiffFrame(encodeDiffFrame(begin))).toEqual(begin);
  }
});

test.each([true, false])(
  "preserves BOM-prefixed paths and source lines with runs=%s",
  (highlight) => {
    const frame = {
      opcode: 0x41 as const,
      slot: 0,
      revision: 1,
      files: [
        {
          path: "\uFEFFbom.ts",
          hunks: [
            {
              oldStart: 1,
              oldCount: 1,
              newStart: 1,
              newCount: 1,
              lines: (["add", "remove", "context"] as const).map((type) => ({
                type,
                content: "\uFEFFvalue",
                runs: highlight ? [{ style: null, length: 6 }] : undefined,
              })),
            },
          ],
        },
      ],
    };
    expect(decodeDiffFrame(encodeDiffFrame(frame))).toEqual(frame);
  },
);
