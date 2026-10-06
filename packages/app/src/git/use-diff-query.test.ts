import { describe, expect, it } from "vitest";
import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import { deriveCheckoutDiffResult } from "./use-diff-query";

function createParsedDiffFile(path: string): ParsedDiffFile {
  return {
    path,
    isNew: false,
    isDeleted: false,
    additions: 3,
    deletions: 1,
    hunks: [
      {
        oldStart: 1,
        oldCount: 1,
        newStart: 1,
        newCount: 1,
        lines: [{ type: "add", content: "x", tokens: [] }],
      },
    ],
  } as ParsedDiffFile;
}

function createPayload(files: ParsedDiffFile[]) {
  return { requestId: "req-1", cwd: "/repo", files, error: null };
}

describe("deriveCheckoutDiffResult", () => {
  // No payload covers every not-yet-fetched case: the query is disabled because the
  // retained panel is still inactive, the request is in flight, or the host is
  // disconnected. None of them mean "the diff is empty".
  it("reports loading while no payload has arrived, so an empty diff is never implied", () => {
    const result = deriveCheckoutDiffResult(null);

    expect(result.isLoading).toBe(true);
    expect(result.files).toEqual([]);
  });

  it("reports a settled empty diff once a payload with zero files arrives", () => {
    const result = deriveCheckoutDiffResult(createPayload([]));

    expect(result.isLoading).toBe(false);
    expect(result.files).toEqual([]);
  });

  it("passes the payload files through once the diff arrives", () => {
    const files = [createParsedDiffFile("src/app.ts")];

    const result = deriveCheckoutDiffResult(createPayload(files));

    expect(result.isLoading).toBe(false);
    expect(result.files).toEqual(files);
  });

  it("surfaces a payload error and the too-large flag", () => {
    const error = { code: "NOT_GIT_REPO", message: "not a git repository" } as const;

    const result = deriveCheckoutDiffResult({ ...createPayload([]), error, diffTooLarge: true });

    expect(result).toEqual({
      files: [],
      payloadError: error,
      diffTooLarge: true,
      isLoading: false,
      isFetching: false,
      isError: true,
      error: null,
    });
  });
});
