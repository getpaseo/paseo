import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  formatChangelogDate,
  parseChangelog,
  type ChangelogRelease,
  type ChangelogSection,
} from "./parse-changelog";

function bodies(markdown: string, releaseIndex = 0): string[] {
  return parseChangelog(markdown)[releaseIndex].sections.map(sectionBody);
}

function sectionBody(section: ChangelogSection): string {
  return section.body;
}

function sectionTitle(section: ChangelogSection): string | null {
  return section.title;
}

function releaseDate(release: ChangelogRelease): string {
  return release.date;
}

function authoredLines(release: ChangelogRelease): string[] {
  return release.sections.flatMap(sectionLines);
}

function sectionLines(section: ChangelogSection): string[] {
  return [...(section.title ? [`### ${section.title}`] : []), ...section.body.split("\n")];
}

function isNotBlank(line: string): boolean {
  return line.trim().length > 0;
}

describe("parseChangelog", () => {
  it("reads the shape the changelog is authored in today", () => {
    const releases = parseChangelog(
      [
        "# Changelog",
        "",
        "## 0.8.0-beta.1 - 2026-09-08",
        "",
        "This release extends what plugins can do.",
        "",
        "### Plugins",
        "",
        "- Added provider contributions ([#4314](https://example.com/4314))",
        "",
        "### Fixed",
        "",
        "- Fixed the mobile terminal keyboard closing",
        "",
        "## 0.7.2 - 2026-09-02",
        "",
        "### Fixed",
        "",
        "- Fixed a thing",
        "",
      ].join("\n"),
    );

    expect(releases).toEqual([
      {
        version: "0.8.0-beta.1",
        date: "2026-09-08",
        sections: [
          { title: null, body: "This release extends what plugins can do." },
          {
            title: "Plugins",
            body: "- Added provider contributions ([#4314](https://example.com/4314))",
          },
          { title: "Fixed", body: "- Fixed the mobile terminal keyboard closing" },
        ],
      },
      {
        version: "0.7.2",
        date: "2026-09-02",
        sections: [{ title: "Fixed", body: "- Fixed a thing" }],
      },
    ]);
  });

  it("drops everything above the first release heading", () => {
    const releases = parseChangelog(
      "# Changelog\n\nAll notable changes.\n\n## 1.0.0 - 2026-01-01\n\n- One\n",
    );
    expect(releases).toHaveLength(1);
    expect(releases[0].sections).toEqual([{ title: null, body: "- One" }]);
  });

  it("returns nothing for a document with no releases", () => {
    expect(parseChangelog("")).toEqual([]);
    expect(parseChangelog("# Changelog\n\nNothing yet.\n")).toEqual([]);
  });

  describe("release headings", () => {
    const headings: [string, { version: string; date: string }][] = [
      ["## 1.2.3 - 2026-01-01", { version: "1.2.3", date: "2026-01-01" }],
      ["## 1.2.3", { version: "1.2.3", date: "" }],
      ["## [1.2.3] - 2026-01-01", { version: "1.2.3", date: "2026-01-01" }],
      ["## v1.2.3 - 2026-01-01", { version: "1.2.3", date: "2026-01-01" }],
      ["## 1.2.3 — 2026-01-01", { version: "1.2.3", date: "2026-01-01" }],
      ["## 1.2.3 – 2026-01-01", { version: "1.2.3", date: "2026-01-01" }],
      ["## 1.2.3 (2026-01-01)", { version: "1.2.3", date: "2026-01-01" }],
      ["## 1.2.3 - January 1, 2026", { version: "1.2.3", date: "January 1, 2026" }],
      [
        "## [1.2.3](https://example.com/v1.2.3) - 2026-01-01",
        { version: "1.2.3", date: "2026-01-01" },
      ],
      ["## Unreleased", { version: "Unreleased", date: "" }],
      ["## [Unreleased]", { version: "Unreleased", date: "" }],
      ["##   1.2.3   -   2026-01-01   ", { version: "1.2.3", date: "2026-01-01" }],
      ["## 1.2.3 - 2026-01-01 ##", { version: "1.2.3", date: "2026-01-01" }],
      ["   ## 1.2.3 - 2026-01-01", { version: "1.2.3", date: "2026-01-01" }],
      ["## 0.8.0-beta.1 - 2026-09-08", { version: "0.8.0-beta.1", date: "2026-09-08" }],
    ];

    for (const [heading, expected] of headings) {
      it(`reads ${JSON.stringify(heading)}`, () => {
        const [release] = parseChangelog(`${heading}\n\n- Entry\n`);
        expect({ version: release.version, date: release.date }).toEqual(expected);
      });
    }

    it("keeps both entries when a version appears twice", () => {
      const releases = parseChangelog(
        "## 1.0.0 - 2026-01-02\n\n- Two\n\n## 1.0.0 - 2026-01-01\n\n- One\n",
      );
      expect(releases.map(releaseDate)).toEqual(["2026-01-02", "2026-01-01"]);
    });

    it("does not treat a deeper heading as a release", () => {
      const releases = parseChangelog("## 1.0.0 - 2026-01-01\n\n#### Deep\n\n- One\n");
      expect(releases).toHaveLength(1);
      expect(releases[0].sections).toEqual([{ title: null, body: "#### Deep\n\n- One" }]);
    });

    it("does not treat an unspaced hash run as a heading", () => {
      const releases = parseChangelog("## 1.0.0 - 2026-01-01\n\n##notaheading\n");
      expect(releases).toHaveLength(1);
      expect(releases[0].sections[0].body).toBe("##notaheading");
    });
  });

  describe("sections", () => {
    it("names sections from the document instead of a fixed list", () => {
      const releases = parseChangelog(
        "## 1.0.0 - 2026-01-01\n\n### Security\n\n- One\n\n### Deprecated\n\n- Two\n",
      );
      expect(releases[0].sections.map(sectionTitle)).toEqual(["Security", "Deprecated"]);
    });

    it("keeps a section that has a heading but no body", () => {
      const releases = parseChangelog("## 1.0.0 - 2026-01-01\n\n### Fixed\n\n### Added\n\n- One\n");
      expect(releases[0].sections).toEqual([
        { title: "Fixed", body: "" },
        { title: "Added", body: "- One" },
      ]);
    });

    it("drops an empty lead section", () => {
      const releases = parseChangelog("## 1.0.0 - 2026-01-01\n\n### Fixed\n\n- One\n");
      expect(releases[0].sections).toEqual([{ title: "Fixed", body: "- One" }]);
    });

    it("keeps a release that is only prose", () => {
      const releases = parseChangelog("## 1.0.0 - 2026-01-01\n\nJust a note.\n");
      expect(releases[0].sections).toEqual([{ title: null, body: "Just a note." }]);
    });
  });

  describe("block kinds it does not interpret", () => {
    it("passes a block quote, callout, table and embed through untouched", () => {
      const source = [
        "## 1.0.0 - 2026-01-01",
        "",
        "### Notes",
        "",
        "> [!WARNING]",
        "> This release drops macOS 12.",
        "",
        "| Platform | Status |",
        "| --- | --- |",
        "| macOS | Shipped |",
        "",
        "![Screenshot](https://example.com/shot.png)",
        "",
        '<video src="https://example.com/demo.mp4" controls></video>',
        "",
        '<iframe src="https://example.com/embed"></iframe>',
        "",
        "<details><summary>More</summary>Hidden</details>",
      ].join("\n");

      expect(bodies(source)).toEqual([source.split("\n").slice(4).join("\n")]);
    });

    it("does not split on a heading inside a fenced code block", () => {
      const source = [
        "## 1.0.0 - 2026-01-01",
        "",
        "### Added",
        "",
        "```md",
        "## 9.9.9 - 2099-01-01",
        "### Fake section",
        "```",
        "",
        "- Real entry",
      ].join("\n");

      const releases = parseChangelog(source);
      expect(releases).toHaveLength(1);
      expect(releases[0].sections).toEqual([
        {
          title: "Added",
          body: "```md\n## 9.9.9 - 2099-01-01\n### Fake section\n```\n\n- Real entry",
        },
      ]);
    });

    it("tracks tilde fences and longer fence runs", () => {
      const source = [
        "## 1.0.0 - 2026-01-01",
        "",
        "~~~~",
        "## 9.9.9",
        "```",
        "~~~~",
        "",
        "- Real entry",
      ].join("\n");

      expect(parseChangelog(source)).toHaveLength(1);
    });

    it("does not split on a heading inside a fence nested in a list item", () => {
      const source = [
        "## 1.0.0 - 2026-01-01",
        "",
        "- Entry with a sample",
        "",
        "  ```",
        "  ## 9.9.9",
        "  ```",
      ].join("\n");

      expect(parseChangelog(source)).toHaveLength(1);
    });
  });

  it("reads CRLF documents", () => {
    const releases = parseChangelog("## 1.0.0 - 2026-01-01\r\n\r\n### Fixed\r\n\r\n- One\r\n");
    expect(releases).toEqual([
      { version: "1.0.0", date: "2026-01-01", sections: [{ title: "Fixed", body: "- One" }] },
    ]);
  });
});

describe("formatChangelogDate", () => {
  it("localizes an ISO date without shifting it across a timezone", () => {
    expect(formatChangelogDate("2026-09-08")).toBe("September 8, 2026");
  });

  it("shows anything else as authored", () => {
    expect(formatChangelogDate("September 8, 2026")).toBe("September 8, 2026");
    expect(formatChangelogDate("")).toBe("");
  });
});

describe("the repository's own CHANGELOG.md", () => {
  const markdown = readFileSync(
    fileURLToPath(new URL("../../../../../CHANGELOG.md", import.meta.url)),
    "utf8",
  );
  const releases = parseChangelog(markdown);

  it("parses every release heading", () => {
    expect(releases.length).toBeGreaterThan(50);
    for (const release of releases) {
      expect(release.version).toMatch(/^\d+\.\d+\.\d+/);
      expect(release.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(release.sections.length).toBeGreaterThan(0);
    }
  });

  it("keeps every authored line inside a release", () => {
    const documentLines = markdown.split("\n");
    const fromFirstRelease = documentLines.slice(
      documentLines.findIndex((line) => line.startsWith("## ")),
    );

    expect(releases.flatMap(authoredLines).filter(isNotBlank)).toEqual(
      fromFirstRelease.filter(isNotBlank).filter((line) => !line.startsWith("## ")),
    );
  });
});
