import { describe, expect, it } from "vitest";
import { buildJiraIssueUrl, extractJiraKeys, normalizeJiraSite } from "./jira";

describe("extractJiraKeys", () => {
  it("finds keys in titles, branches and PR titles, first occurrence wins, no duplicates", () => {
    expect(
      extractJiraKeys([
        "Fraudify integration DCAI-2081",
        "feature/DCAI-2081-fraudify",
        null,
        "VIZ-35: model choice, see also DCAI-12",
      ]),
    ).toEqual(["DCAI-2081", "VIZ-35", "DCAI-12"]);
  });

  it("ignores lowercase spellings and keys running into trailing letters", () => {
    expect(extractJiraKeys(["dcai-2081-fix", "XDCAI-1", "ABCDCAI-2081x", undefined])).toEqual([
      "XDCAI-1",
    ]);
  });

  it("needs at least two characters before the dash", () => {
    expect(extractJiraKeys(["A-1 B2-3"])).toEqual(["B2-3"]);
  });
});

describe("normalizeJiraSite", () => {
  it("keeps an https origin and drops trailing slashes", () => {
    expect(normalizeJiraSite(" https://9elf26.atlassian.net/ ")).toBe(
      "https://9elf26.atlassian.net",
    );
  });

  it("adds https to a bare host", () => {
    expect(normalizeJiraSite("example.atlassian.net")).toBe("https://example.atlassian.net");
  });

  it("keeps a path prefix for self-hosted Jira", () => {
    expect(normalizeJiraSite("http://jira.local:8080/jira/")).toBe("http://jira.local:8080/jira");
  });

  it("rejects empty input and other schemes", () => {
    expect(normalizeJiraSite("   ")).toBeNull();
    expect(normalizeJiraSite("ftp://jira.example.com")).toBeNull();
    expect(normalizeJiraSite("javascript://alert(1)")).toBeNull();
  });
});

describe("buildJiraIssueUrl", () => {
  it("links the browse page of the key", () => {
    expect(buildJiraIssueUrl("https://example.atlassian.net", "DCAI-2081")).toBe(
      "https://example.atlassian.net/browse/DCAI-2081",
    );
  });
});
