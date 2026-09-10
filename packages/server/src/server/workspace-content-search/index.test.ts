import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { searchWorkspaceContent } from "./index.js";

const roots: string[] = [];
async function workspace(files: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-content-search-"));
  roots.push(root);
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(root, name), text);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("searches saved untracked text literally, ignoring case and ignore rules in a non-Git workspace", async () => {
  const cwd = await workspace({
    "a.ts": "é🙂 NEEDLE needle\r\n",
    "b.ts": "a.b AXB",
    ".hidden": "Needle",
    ".gitignore": "ignored\n",
    ignored: "needle",
  });
  const result = await searchWorkspaceContent({ cwd, query: "needle" });
  expect(result).toEqual({
    status: "ok",
    limited: false,
    maxFileBytes: 1_048_576,
    matches: [
      {
        path: ".hidden",
        line: 1,
        columnStart: 1,
        columnEnd: 7,
        text: "Needle",
        snippet: "Needle",
        snippetMatchStart: 0,
        snippetMatchEnd: 6,
      },
      {
        path: "a.ts",
        line: 1,
        columnStart: 5,
        columnEnd: 11,
        text: "NEEDLE",
        snippet: "é🙂 NEEDLE needle",
        snippetMatchStart: 4,
        snippetMatchEnd: 10,
      },
      {
        path: "a.ts",
        line: 1,
        columnStart: 12,
        columnEnd: 18,
        text: "needle",
        snippet: "é🙂 NEEDLE needle",
        snippetMatchStart: 11,
        snippetMatchEnd: 17,
      },
    ],
  });
  const literal = await searchWorkspaceContent({ cwd, query: "a.b" });
  expect(literal.status === "ok" && literal.matches.map((m) => m.text)).toEqual(["a.b"]);
});

test("reports missing rg, empty search, cancellation and file/result limits", async () => {
  const cwd = await workspace({
    "many.txt": "needle\n".repeat(250),
    oversized: "needle" + " ".repeat(1_048_576),
  });
  const result = await searchWorkspaceContent({ cwd, query: "needle" });
  expect(result.status === "ok" && [result.matches.length, result.limited]).toEqual([200, true]);
  expect(await searchWorkspaceContent({ cwd, query: "" })).toEqual({
    status: "ok",
    matches: [],
    limited: false,
    maxFileBytes: 1_048_576,
  });
  expect(await searchWorkspaceContent({ cwd, query: "x" }, { env: { PATH: "" } })).toMatchObject({
    status: "error",
    code: "missing_rg",
  });
  expect(
    await searchWorkspaceContent({ cwd, query: "x", signal: AbortSignal.abort() }),
  ).toMatchObject({ status: "error", code: "cancelled" });
});

test("preserves Unicode case-fold matches and BOM offsets, rejects binary files and bounds long records", async () => {
  const cwd = await workspace({
    unicode: "\uFEFFé🙂 K k K ſ S s σ Σ ς\r\n",
    binary: "needle\0binary",
    long: "x".repeat(1_040_000) + "needle",
  });
  const kelvin = await searchWorkspaceContent({ cwd, query: "k" });
  expect(kelvin.status === "ok" && kelvin.matches.map((m) => [m.text, m.columnStart])).toEqual([
    ["K", 5],
    ["k", 7],
    ["K", 9],
  ]);
  const sigma = await searchWorkspaceContent({ cwd, query: "σ" });
  expect(sigma.status === "ok" && sigma.matches.map((m) => m.text)).toEqual(["σ", "Σ", "ς"]);
  const binary = await searchWorkspaceContent({ cwd, query: "needle" });
  expect(binary.status === "ok" && binary.matches.map((m) => m.path)).toEqual(["long"]);
});

test("bounds escaped output and reports timeouts and invalid single-line queries", async () => {
  const cwd = await workspace({ escaped: "\t".repeat(600_000) + "needle" });
  expect(await searchWorkspaceContent({ cwd, query: "needle" })).toMatchObject({
    status: "ok",
    limited: true,
  });
  expect(await searchWorkspaceContent({ cwd, query: "x\ny" })).toMatchObject({
    status: "error",
    code: "invalid_query",
  });
  expect(await searchWorkspaceContent({ cwd, query: "needle" }, { timeoutMs: 0 })).toMatchObject({
    status: "error",
    code: "timeout",
  });
});

test("uses source lines across CR-only and mixed separators, including unmatched preceding lines", async () => {
  const cwd = await workspace({
    "cr.txt": "first\rneedle",
    "mixed.txt": "unmatched\rprefix\nfirst\r🙂 NEEDLE\r\nend",
  });
  const result = await searchWorkspaceContent({ cwd, query: "needle" });
  expect(
    result.status === "ok" &&
      result.matches.map(({ path: filePath, line, columnStart, columnEnd, text }) => ({
        path: filePath,
        line,
        columnStart,
        columnEnd,
        text,
      })),
  ).toEqual([
    { path: "cr.txt", line: 2, columnStart: 1, columnEnd: 7, text: "needle" },
    { path: "mixed.txt", line: 4, columnStart: 4, columnEnd: 10, text: "NEEDLE" },
  ]);
});

test("validates UTF-8 beyond the matching record and preserves an embedded BOM character", async () => {
  const cwd = await workspace({ "valid.txt": "prefix \uFEFFneedle" });
  await writeFile(
    path.join(cwd, "invalid.txt"),
    Buffer.from([110, 101, 101, 100, 108, 101, 10, 255]),
  );
  const invalid = await searchWorkspaceContent({ cwd, query: "needle" });
  expect(invalid.status === "ok" && invalid.matches.map((match) => match.path)).toEqual([
    "valid.txt",
  ]);
  const embedded = await searchWorkspaceContent({ cwd, query: "\uFEFFneedle" });
  expect(
    embedded.status === "ok" && embedded.matches.map((match) => [match.text, match.columnStart]),
  ).toEqual([["\uFEFFneedle", 8]]);
});

test("states the per-file ceiling so a search that skipped an oversized file is not reported as complete", async () => {
  const cwd = await workspace({ "large.txt": `needle${" ".repeat(1_048_576)}` });
  expect(await searchWorkspaceContent({ cwd, query: "needle" })).toEqual({
    status: "ok",
    matches: [],
    limited: false,
    maxFileBytes: 1_048_576,
  });
  await writeFile(path.join(cwd, "small.txt"), "needle");
  const withSmall = await searchWorkspaceContent({ cwd, query: "needle" });
  expect(
    withSmall.status === "ok" && [withSmall.matches.map((m) => m.path), withSmall.maxFileBytes],
  ).toEqual([["small.txt"], 1_048_576]);
});

// A backslash is an ordinary character in a Unix file name but a separator on Windows, so this
// file name only exists on POSIX. Windows separator handling is covered by toWorkspaceRelativePath,
// which runs on every platform.
test.skipIf(process.platform === "win32")(
  "keeps a literal backslash in a saved file name exactly as the host reported it",
  async () => {
    const cwd = await workspace({ "a\\b.txt": "needle" });
    const result = await searchWorkspaceContent({ cwd, query: "needle" });
    expect(result.status === "ok" && result.matches.map((match) => match.path)).toEqual([
      "a\\b.txt",
    ]);
  },
);
