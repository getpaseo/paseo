import { describe, expect, it } from "vitest";
import { extractForgeRefs, parseForgeRef } from "./forge-refs";

describe("parseForgeRef", () => {
  it.each([
    [
      "GitHub pull request",
      "git@github.com:getpaseo/paseo.git",
      "https://github.com/getpaseo/paseo/pull/994/files?diff=split#discussion_r123",
      { kind: "change_request", number: 994 },
    ],
    [
      "GitHub issue",
      "https://github.com/getpaseo/paseo.git",
      "https://github.com/getpaseo/paseo/issues/456",
      { kind: "issue", number: 456 },
    ],
    [
      "nested GitLab merge request",
      "git@gitlab.com:group/subgroup/project.git",
      "https://gitlab.com/group/subgroup/project/-/merge_requests/73/diffs",
      { kind: "change_request", number: 73 },
    ],
    [
      "GitLab issue",
      "https://gitlab.com/group/project.git",
      "https://gitlab.com/group/project/-/issues/19#note_1",
      { kind: "issue", number: 19 },
    ],
    [
      "self-hosted Gitea pull request",
      "ssh://git@git.example.com/acme/project.git",
      "https://git.example.com/acme/project/pulls/31/files",
      { kind: "change_request", number: 31 },
    ],
    [
      "Forgejo issue",
      "git@forgejo.example.com:acme/project.git",
      "https://forgejo.example.com/acme/project/issues/27",
      { kind: "issue", number: 27 },
    ],
    [
      "Codeberg pull request",
      "git@codeberg.org:acme/project.git",
      "https://codeberg.org/acme/project/pulls/8",
      { kind: "change_request", number: 8 },
    ],
  ])("parses a matching %s URL", (_label, remote, text, expected) => {
    expect(parseForgeRef(text, remote)).toEqual(expected);
  });

  it("canonicalizes a cloud SSH alias to its web host", () => {
    expect(
      parseForgeRef(
        "https://github.com/getpaseo/paseo/pull/994",
        "ssh://git@ssh.github.com/getpaseo/paseo.git",
      ),
    ).toEqual({ kind: "change_request", number: 994 });
  });

  it("ignores another host, repository, and malformed local id", () => {
    const remote = "git@gitlab.com:group/project.git";
    expect(
      parseForgeRef("https://other.example/group/project/-/merge_requests/1", remote),
    ).toBeNull();
    expect(parseForgeRef("https://gitlab.com/group/other/-/merge_requests/1", remote)).toBeNull();
    expect(
      parseForgeRef("https://gitlab.com/group/project/-/merge_requests/1oops", remote),
    ).toBeNull();
  });

  it("does not apply another forge's route grammar to a known cloud host", () => {
    expect(
      parseForgeRef(
        "https://github.com/getpaseo/paseo/pulls/31",
        "git@github.com:getpaseo/paseo.git",
      ),
    ).toBeNull();
    expect(
      parseForgeRef("https://gitlab.com/group/project/pull/31", "git@gitlab.com:group/project.git"),
    ).toBeNull();
  });
});

describe("extractForgeRefs", () => {
  it("extracts matching references in text order and deduplicates them", () => {
    const text = [
      "[MR](https://gitlab.com/group/project/-/merge_requests/12/diffs).",
      "https://gitlab.com/group/project/-/issues/34#note_1,",
      "https://gitlab.com/group/project/-/merge_requests/12",
      "https://gitlab.com/group/other/-/issues/99",
    ].join("\n");

    expect(extractForgeRefs(text, "git@gitlab.com:group/project.git")).toEqual([
      { kind: "change_request", number: 12 },
      { kind: "issue", number: 34 },
    ]);
  });

  it("returns no references without text or a valid remote", () => {
    expect(extractForgeRefs("", "git@github.com:getpaseo/paseo.git")).toEqual([]);
    expect(extractForgeRefs("https://github.com/getpaseo/paseo/pull/1", null)).toEqual([]);
  });
});
