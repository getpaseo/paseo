import { describe, expect, it } from "vitest";
import { parseChangelog } from "./parse-changelog";
import { groupReleases, revealGroups, type ChangelogReleaseGroup } from "./release-groups";

const CHANGELOG = [
  "# Changelog",
  "",
  "## 0.16.1 - 2026-11-17",
  "",
  "### Fixed",
  "",
  "- Fixed a patch thing",
  "",
  "## 0.16.0 - 2026-11-16",
  "",
  "- **Background tasks:** Paseo shows the tasks an agent runs.",
  "",
  "### Added",
  "",
  "- Added a minor thing",
  "",
  "## 0.15.1 - 2026-11-05",
  "",
  "### Fixed",
  "",
  "- Fixed an older patch thing",
  "",
  "## 0.15.0 - 2026-11-03",
  "",
  "### Fixed",
  "",
  "- Fixed an older minor thing",
  "",
].join("\n");

function versions(group: ChangelogReleaseGroup): string[] {
  return group.releases.map((release) => release.version);
}

describe("groupReleases", () => {
  const [latest, older] = groupReleases(parseChangelog(CHANGELOG));

  it("keeps the minor's highlights when a patch ships", () => {
    expect(latest).toMatchObject({
      version: "0.16",
      label: "0.16",
      highlights: "- **Background tasks:** Paseo shows the tasks an agent runs.",
    });
  });

  it("lists every entry of the minor newest first, without repeating the highlights", () => {
    expect(versions(latest)).toEqual(["0.16.1", "0.16.0"]);
    expect(latest.releases[1]).toMatchObject({
      highlights: "",
      sections: [{ title: "Added", body: "- Added a minor thing" }],
    });
  });

  it("has no highlights when the entry that opened the minor had none", () => {
    expect(older).toMatchObject({ version: "0.15", highlights: "" });
    expect(versions(older)).toEqual(["0.15.1", "0.15.0"]);
  });

  it("keeps a patch's own highlights with that patch", () => {
    const [group] = groupReleases(
      parseChangelog(
        "## 1.2.1 - 2026-01-02\n\nA sponsor joined.\n\n## 1.2.0 - 2026-01-01\n\n- **New:** Thing.\n",
      ),
    );

    expect(group.highlights).toBe("- **New:** Thing.");
    expect(group.releases[0].highlights).toBe("A sponsor joined.");
  });

  it("labels a minor that has shipped only as a beta with the beta's version", () => {
    const [beta, stable] = groupReleases(
      parseChangelog("## 0.17.0-beta.2 - 2026-11-20\n\n- **New:** Thing.\n\n" + CHANGELOG),
    );

    expect(beta).toMatchObject({ version: "0.17", label: "0.17.0-beta.2" });
    expect(stable.label).toBe("0.16");
  });

  it("keeps the minor's label when a patch of it is in beta", () => {
    const [group] = groupReleases(
      parseChangelog("## 0.16.2-beta.1 - 2026-11-20\n\n### Fixed\n\n- One\n\n" + CHANGELOG),
    );

    expect(group.label).toBe("0.16");
    expect(versions(group)).toEqual(["0.16.2-beta.1", "0.16.1", "0.16.0"]);
  });

  it("gives a version without a minor a group of its own", () => {
    const groups = groupReleases(parseChangelog("## Unreleased\n\n- One\n\n" + CHANGELOG));

    expect(groups.map((group) => group.version)).toEqual(["Unreleased", "0.16", "0.15"]);
  });
});

describe("revealGroups", () => {
  const groups = groupReleases(parseChangelog(CHANGELOG));

  it("counts a minor with highlights as one item", () => {
    expect(revealGroups(groups, 1)).toEqual({ groups: [groups[0]], hasMore: true });
  });

  it("cuts a minor without highlights at the entry that reaches the count", () => {
    const revealed = revealGroups(groups, 2);

    expect(revealed.groups.map(versions)).toEqual([["0.16.1", "0.16.0"], ["0.15.1"]]);
    expect(revealed.hasMore).toBe(true);
  });

  it("has no more once every entry is revealed", () => {
    expect(revealGroups(groups, 3)).toEqual({ groups, hasMore: false });
    expect(revealGroups(groups, 10)).toEqual({ groups, hasMore: false });
  });
});
