import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { searchDirectoryEntries } from "./directory-suggestions.js";

const reportedFiles = [
  "data/prices/claude.json",
  "docs/architecture.ts",
  "docs/reference/ai模型价格-Claude.md",
  "scripts/cleanup_codex_cua_orphans.sh",
  "src/chat-input.tsx",
  "src/chronicle.ts",
];
const longPath = `needle/${"a".repeat(80)}/${"b".repeat(80)}/file.txt`;

// Keep diagnostic fixtures in the workspace, separate from the user's files.
function fixture(files: string[]): string {
  const artifacts = path.resolve(import.meta.dirname, "../../../../.artifacts");
  mkdirSync(artifacts, { recursive: true });
  const root = mkdtempSync(path.join(artifacts, "file-search-7650-"));
  for (const file of files) {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "");
  }
  return root;
}

async function search(root: string, query: string): Promise<string[]> {
  return (
    await searchDirectoryEntries({
      root,
      query,
      pathFormat: "relative",
      pathQueryPolicy: "slashes",
      includeFiles: true,
      includeDirectories: false,
    })
  ).map((entry) => entry.path);
}

describe("#7650 reported search expectations", () => {
  let root: string;
  beforeAll(() => {
    root = fixture(reportedFiles);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("requires both parts of a mixed-script query", async () => {
    expect(await search(root, "claude价格")).toEqual(["docs/reference/ai模型价格-Claude.md"]);
  });

  it("prefers the filename abbreviation over a mid-word substring", async () => {
    expect(await search(root, "chi")).toEqual([
      "src/chat-input.tsx",
      "src/chronicle.ts",
      "docs/architecture.ts",
    ]);
  });
});

describe("#7650 existing search compatibility", () => {
  let root: string;
  beforeAll(() => {
    root = fixture(["привет.md", "설정.md", "résumé.md", "---.md", longPath]);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it.each([
    ["привет", "привет.md"],
    ["설정", "설정.md"],
    ["résumé", "résumé.md"],
    ["---", "---.md"],
    ["needle", longPath],
  ])("preserves matching for %s", async (query, expected) => {
    expect(await search(root, query)).toContain(expected);
  });
});
