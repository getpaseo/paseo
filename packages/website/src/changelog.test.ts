import { describe, expect, it } from "vitest";
import { getChangelogReleaseGroups, localizeReleases, parseChangelog } from "~/changelog";

const ENGLISH = parseChangelog(
  [
    "# Changelog",
    "",
    "## 0.2.0 - 2026-05-02",
    "",
    "- New",
    "",
    "## 0.1.0 - 2026-05-01",
    "",
    "- Old",
  ].join("\n"),
  "en",
);

describe("parseChangelog", () => {
  it("splits a release into the highlights it leads with and its sections", () => {
    const [release] = parseChangelog(
      [
        "## 0.3.0 - 2026-05-03",
        "",
        "- **Faster diffs:** Diffs load sooner.",
        "",
        "### Added",
        "",
        "- Added a picker",
        "",
        "### Fixed",
        "",
        "- Fixed a crash",
        "",
      ].join("\n"),
      "en",
    );

    expect(release).toEqual({
      version: "0.3.0",
      date: "2026-05-03",
      highlights: "- **Faster diffs:** Diffs load sooner.",
      sections: "### Added\n\n- Added a picker\n\n### Fixed\n\n- Fixed a crash",
      locale: "en",
    });
  });

  it("has no highlights when a release opens with a section", () => {
    const [release] = parseChangelog("## 0.3.0 - 2026-05-03\n\n### Fixed\n\n- One\n", "en");

    expect(release).toMatchObject({ highlights: "", sections: "### Fixed\n\n- One" });
  });
});

describe("localizeReleases", () => {
  it("uses a translation whose version and date match the English entry", () => {
    const chinese = parseChangelog("## 0.1.0 - 2026-05-01\n\n- 旧\n", "zh-CN");

    expect(localizeReleases(ENGLISH, chinese).map((release) => release.locale)).toEqual([
      "en",
      "zh-CN",
    ]);
  });

  it("shows a release in English when its notes changed after translation", () => {
    const stale = parseChangelog("## 0.2.0 - 2026-04-30\n\n- 新\n", "zh-CN");

    expect(localizeReleases(ENGLISH, stale)[0]).toBe(ENGLISH[0]);
  });

  it("drops a translation whose English entry was renamed, as when a beta is promoted", () => {
    const beta = parseChangelog("## 0.2.0-beta.1 - 2026-05-02\n\n- 新\n", "zh-CN");

    expect(localizeReleases(ENGLISH, beta)).toEqual(ENGLISH);
  });

  it("refuses a duplicated version", () => {
    expect(() => parseChangelog("## 1.0.0 - 2026-05-01\n## 1.0.0 - 2026-05-01\n", "zh-CN")).toThrow(
      "Duplicate changelog version: 1.0.0",
    );
  });
});

function publishedVersions(locale: "en" | "zh-CN"): string[] {
  return getChangelogReleaseGroups(locale)
    .flatMap((group) => group.releases)
    .map((release) => `${release.version} ${release.date}`);
}

describe("the published changelog", () => {
  it("lists the same releases in every language", () => {
    expect(publishedVersions("zh-CN")).toEqual(publishedVersions("en"));
  });
});
