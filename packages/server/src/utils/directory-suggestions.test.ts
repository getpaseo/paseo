import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { searchHomeDirectories } from "./directory-suggestions.js";

describe("searchHomeDirectories", () => {
  let tempRoot: string;
  let homeDir: string;
  let outsideDir: string;

  beforeEach(() => {
    tempRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "directory-suggestions-")));
    homeDir = path.join(tempRoot, "home");
    outsideDir = path.join(tempRoot, "outside");

    mkdirSync(homeDir, { recursive: true });
    mkdirSync(outsideDir, { recursive: true });

    mkdirSync(path.join(homeDir, "projects", "paseo"), { recursive: true });
    mkdirSync(path.join(homeDir, "projects", "playground"), { recursive: true });
    mkdirSync(path.join(homeDir, "documents", "plans"), { recursive: true });
    mkdirSync(path.join(homeDir, ".hidden", "cache"), { recursive: true });
    writeFileSync(path.join(homeDir, "projects", "README.md"), "not a directory\n");

    mkdirSync(path.join(outsideDir, "outside-match"), { recursive: true });
    symlinkSync(path.join(outsideDir, "outside-match"), path.join(homeDir, "outside-link"));
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  it("returns an empty list for blank queries", async () => {
    await expect(
      searchHomeDirectories({
        homeDir,
        query: "   ",
        limit: 10,
      })
    ).resolves.toEqual([]);
  });

  it("returns only existing directories", async () => {
    const results = await searchHomeDirectories({
      homeDir,
      query: "proj",
      limit: 10,
    });

    expect(results).toContain(path.join(homeDir, "projects"));
    expect(results).toContain(path.join(homeDir, "projects", "paseo"));
    expect(results).not.toContain(path.join(homeDir, "projects", "README.md"));
  });

  it("supports home-relative path query syntax", async () => {
    const results = await searchHomeDirectories({
      homeDir,
      query: "~/projects/pa",
      limit: 10,
    });

    expect(results).toEqual([
      path.join(homeDir, "projects", "paseo"),
    ]);
  });

  it("prioritizes exact segment matches before segment-prefix matches", async () => {
    const exactSegmentPath = path.join(
      homeDir,
      "something",
      "faro",
      "something-else"
    );
    const prefixSegmentPath = path.join(
      homeDir,
      "something",
      "somethingelse",
      "faro-bla"
    );
    mkdirSync(exactSegmentPath, { recursive: true });
    mkdirSync(prefixSegmentPath, { recursive: true });

    const results = await searchHomeDirectories({
      homeDir,
      query: "faro",
      limit: 30,
    });

    const exactIndex = results.indexOf(exactSegmentPath);
    const prefixIndex = results.indexOf(prefixSegmentPath);
    expect(exactIndex).toBeGreaterThanOrEqual(0);
    expect(prefixIndex).toBeGreaterThanOrEqual(0);
    expect(exactIndex).toBeLessThan(prefixIndex);
  });

  it("prioritizes partial matches that appear earlier in the path", async () => {
    const earlierPath = path.join(homeDir, "farofoo");
    const laterPath = path.join(homeDir, "x", "y", "farofoo");
    mkdirSync(earlierPath, { recursive: true });
    mkdirSync(laterPath, { recursive: true });

    const results = await searchHomeDirectories({
      homeDir,
      query: "arofo",
      limit: 30,
    });

    const earlierIndex = results.indexOf(earlierPath);
    const laterIndex = results.indexOf(laterPath);
    expect(earlierIndex).toBeGreaterThanOrEqual(0);
    expect(laterIndex).toBeGreaterThanOrEqual(0);
    expect(earlierIndex).toBeLessThan(laterIndex);
  });

  it("returns home-root suggestions when query is '~'", async () => {
    const results = await searchHomeDirectories({
      homeDir,
      query: "~",
      limit: 20,
    });

    expect(results).toContain(path.join(homeDir, "projects"));
    expect(results).toContain(path.join(homeDir, "documents"));
  });

  it("does not return paths that escape home through symlinks", async () => {
    const results = await searchHomeDirectories({
      homeDir,
      query: "outside",
      limit: 20,
    });

    expect(results).not.toContain(path.join(homeDir, "outside-link"));
    expect(results).not.toContain(path.join(outsideDir, "outside-match"));
  });

  it("respects the result limit", async () => {
    const results = await searchHomeDirectories({
      homeDir,
      query: "p",
      limit: 1,
    });

    expect(results).toHaveLength(1);
  });
});
