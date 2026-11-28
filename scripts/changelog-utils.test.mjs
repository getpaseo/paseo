import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseChangelogEntries, splitChangelogHighlights } from "./changelog-utils.mjs";

// The cases the app, the website and the release scripts must all split the same way.
const structureCases = JSON.parse(
  readFileSync(new URL("./test-support/changelog-structure.json", import.meta.url), "utf8"),
);

for (const lineEnding of ["\n", "\r\n"]) {
  test(`splits the shared cases with ${JSON.stringify(lineEnding)} line endings`, () => {
    const entries = parseChangelogEntries(structureCases.document.join(lineEnding));

    assert.deepEqual(
      entries.map((entry) => {
        const { highlightLines, sectionLines } = splitChangelogHighlights(entry.bodyLines);
        return {
          version: entry.version,
          date: entry.date,
          highlights: highlightLines,
          sections: sectionLines,
        };
      }),
      structureCases.releases.map((release) => ({
        version: release.version,
        date: release.date,
        highlights: release.highlights,
        sections: release.sections,
      })),
    );
  });
}

test("finds an entry for every release heading line in the repository's CHANGELOG.md", () => {
  for (const file of ["CHANGELOG.md", "CHANGELOG.zh-CN.md"]) {
    const changelog = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    const headingLines = changelog.split("\n").filter((line) => line.startsWith("## "));
    assert.equal(parseChangelogEntries(changelog).length, headingLines.length, file);
  }
});
