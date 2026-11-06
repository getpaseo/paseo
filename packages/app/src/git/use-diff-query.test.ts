import { describe, expect, it } from "vitest";
import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import { deriveCheckoutDiffResult } from "./diff-snapshot";

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
      entries: null,
      payloadError: error,
      diffTooLarge: true,
      isLoading: false,
      isFetching: false,
      isError: true,
      error: null,
    });
  });
});

it("shows the announced tree while file bodies are still loading", () => {
  const entries = [
    {
      path: "src/app.ts",
      oldPath: null,
      change: "modified",
      content: "text",
      additions: 3,
      deletions: 1,
    },
  ] as const;
  const result = deriveCheckoutDiffResult({ ...createPayload([]), entries: [...entries] });
  expect(result.isLoading).toBe(true);
  expect(result.entries).toEqual(entries);
  expect(result.files).toEqual([]);
});

it("settles a comparison without a base and leaves Uncommitted available", async () => {
  const { checkoutDiffComparisonError } = await import("./diff-snapshot");
  expect(checkoutDiffComparisonError({ mode: "all" })).toMatchObject({ code: "INVALID_COMPARE" });
  expect(checkoutDiffComparisonError({ mode: "base" })).toMatchObject({ code: "INVALID_COMPARE" });
  expect(checkoutDiffComparisonError({ mode: "uncommitted" })).toBeNull();
});
