import { describe, it, expect } from "vitest";
import {
  ContentSearchRequestSchema,
  ContentSearchResponseSchema,
  ProjectNestedReposScanResponseSchema,
} from "./messages";

describe("ContentSearchRequestSchema", () => {
  it("parses a valid request", () => {
    const parsed = ContentSearchRequestSchema.safeParse({
      type: "fs.content_search.request",
      cwd: "/repo",
      query: "needle",
      requestId: "req_1",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects queries shorter than 2 characters", () => {
    const parsed = ContentSearchRequestSchema.safeParse({
      type: "fs.content_search.request",
      cwd: "/repo",
      query: "n",
      requestId: "req_1",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects queries longer than 200 characters", () => {
    const parsed = ContentSearchRequestSchema.safeParse({
      type: "fs.content_search.request",
      cwd: "/repo",
      query: "n".repeat(201),
      requestId: "req_1",
    });
    expect(parsed.success).toBe(false);
  });
});

describe("ContentSearchResponseSchema", () => {
  it("parses a grouped result payload", () => {
    const parsed = ContentSearchResponseSchema.safeParse({
      type: "fs.content_search.response",
      payload: {
        cwd: "/repo",
        query: "needle",
        files: [{ relPath: "src/a.ts", matches: [{ line: 2, text: "needle here" }] }],
        truncated: false,
        error: null,
        requestId: "req_1",
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects a match without a positive line number", () => {
    const parsed = ContentSearchResponseSchema.safeParse({
      type: "fs.content_search.response",
      payload: {
        cwd: "/repo",
        query: "needle",
        files: [{ relPath: "src/a.ts", matches: [{ line: 0, text: "needle" }] }],
        truncated: false,
        error: null,
        requestId: "req_1",
      },
    });
    expect(parsed.success).toBe(false);
  });
});

describe("ProjectNestedReposScanResponseSchema", () => {
  it("parses checkouts with branch and worktree flag", () => {
    const parsed = ProjectNestedReposScanResponseSchema.safeParse({
      type: "project.nested_repos.scan_response",
      payload: {
        parentCwd: "/root",
        repos: [{ path: "/root/.worktrees/wt", name: "wt", isWorktree: true, branch: "feat/x" }],
        error: null,
        requestId: "req_1",
      },
    });
    expect(parsed.success).toBe(true);
  });
});
