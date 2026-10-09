import { useCallback, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePersistedViewedFiles } from "./use-persisted-viewed-files";
import { viewedFileRevision } from "./viewed-files";

// Exercise AsyncStorage's browser implementation, rather than the Node storage stub.
interface BrowserStorageModule {
  default: typeof AsyncStorage;
}
vi.mock("@react-native-async-storage/async-storage", () =>
  vi.importActual<BrowserStorageModule>(
    "@react-native-async-storage/async-storage/lib/module/AsyncStorage",
  ),
);

const STORAGE_KEY = "@paseo:working-diff-viewed-files:browser-test";
const OTHER_KEY = `${STORAGE_KEY}:other`;
const file: ParsedDiffFile = {
  path: "src/a.ts",
  status: "ok",
  isNew: false,
  isDeleted: false,
  additions: 1,
  deletions: 0,
  hunks: [
    {
      oldStart: 1,
      oldCount: 0,
      newStart: 1,
      newCount: 1,
      lines: [{ type: "add", content: "const a = 1;" }],
    },
  ],
};

interface ReviewProps {
  storageKey: string;
  files: ParsedDiffFile[];
}

function Review({ storageKey, files }: ReviewProps) {
  const review = usePersistedViewedFiles({ storageKey, files });
  const [saved, setSaved] = useState(false);
  const currentFile = files[0];
  const { toggleFileViewed, invalidateViewedFiles, changedPaths } = review;
  const toggleViewed = useCallback(() => {
    if (currentFile) toggleFileViewed(currentFile, setSaved);
  }, [currentFile, toggleFileViewed]);
  const invalidate = useCallback(
    () => invalidateViewedFiles(changedPaths),
    [invalidateViewedFiles, changedPaths],
  );
  return (
    <div>
      <output data-testid="saved">{String(saved)}</output>
      {review.error ? <p data-testid="diff-viewed-error">{review.error.message}</p> : null}
      <button type="button" onClick={invalidate}>
        Invalidate
      </button>
      <button type="button" onClick={review.retry}>
        Retry
      </button>
      {currentFile ? (
        <button
          type="button"
          data-testid="diff-file-0-mark-as-viewed"
          disabled={review.isLoading || review.isSaving || review.isLoadError}
          aria-selected={review.viewedFiles.has(currentFile.path)}
          onClick={toggleViewed}
        >
          {currentFile.path}
        </button>
      ) : null}
    </div>
  );
}

function mountReview(props: ReviewProps) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <Review {...props} />
    </QueryClientProvider>,
  );
  return {
    ...view,
    client,
    rerenderReview: (next: ReviewProps) =>
      view.rerender(
        <QueryClientProvider client={client}>
          <Review {...next} />
        </QueryClientProvider>,
      ),
  };
}

beforeEach(async () => {
  await AsyncStorage.multiRemove([STORAGE_KEY, OTHER_KEY]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("viewed files in a working diff", () => {
  it("saves a viewed file and restores it after remount", async () => {
    const view = mountReview({ storageKey: STORAGE_KEY, files: [file] });
    const action = page.getByTestId("diff-file-0-mark-as-viewed");
    await expect.element(action).toBeEnabled();
    await action.click();
    await expect.element(page.getByTestId("saved")).toHaveTextContent("true");
    await expect.element(action).toHaveAttribute("aria-selected", "true");
    expect(JSON.parse((await AsyncStorage.getItem(STORAGE_KEY)) ?? "null")).toEqual({
      [file.path]: viewedFileRevision(file),
    });

    view.unmount();
    mountReview({ storageKey: STORAGE_KEY, files: [structuredClone(file)] });
    await expect
      .element(page.getByTestId("diff-file-0-mark-as-viewed"))
      .toHaveAttribute("aria-selected", "true");
  });

  it("keeps persisted revisions when storage loads before the diff", async () => {
    await AsyncStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ [file.path]: viewedFileRevision(file) }),
    );
    const view = mountReview({ storageKey: STORAGE_KEY, files: [] });
    await expect
      .poll(() => view.client.getQueryState(["working-diff-viewed-files", STORAGE_KEY])?.status)
      .toBe("success");
    view.rerenderReview({ storageKey: STORAGE_KEY, files: [file] });
    await expect
      .element(page.getByTestId("diff-file-0-mark-as-viewed"))
      .toHaveAttribute("aria-selected", "true");
  });

  it("compacts a legacy record before marking another file", async () => {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ [file.path]: JSON.stringify(file) }));
    const view = mountReview({ storageKey: STORAGE_KEY, files: [file] });
    const action = page.getByTestId("diff-file-0-mark-as-viewed");
    await expect.element(action).toBeEnabled();
    await expect.element(action).toHaveAttribute("aria-selected", "true");
    await expect
      .poll(() => AsyncStorage.getItem(STORAGE_KEY))
      .toBe(JSON.stringify({ [file.path]: viewedFileRevision(file) }));

    const other = { ...file, path: "src/b.ts" };
    view.rerenderReview({ storageKey: STORAGE_KEY, files: [other, file] });
    await action.click();
    await expect.element(action).toHaveAttribute("aria-selected", "true");
    expect(JSON.parse((await AsyncStorage.getItem(STORAGE_KEY)) ?? "null")).toEqual({
      [file.path]: viewedFileRevision(file),
      [other.path]: viewedFileRevision(other),
    });
  });

  it("invalidates a viewed file when its content changes", async () => {
    const view = mountReview({ storageKey: STORAGE_KEY, files: [file] });
    const action = page.getByTestId("diff-file-0-mark-as-viewed");
    await expect.element(action).toBeEnabled();
    await action.click();
    await expect.element(action).toHaveAttribute("aria-selected", "true");
    view.rerenderReview({ storageKey: STORAGE_KEY, files: [{ ...file, additions: 2 }] });
    await expect.element(action).toHaveAttribute("aria-selected", "false");
    await page.getByRole("button", { name: "Invalidate", exact: true }).click();
    await expect.poll(() => AsyncStorage.getItem(STORAGE_KEY)).toBe("{}");
  });

  it("disables marking until a delayed storage read completes", async () => {
    let completeRead!: (value: string | null) => void;
    vi.spyOn(AsyncStorage, "getItem").mockReturnValueOnce(
      new Promise((resolve) => {
        completeRead = resolve;
      }),
    );
    mountReview({ storageKey: STORAGE_KEY, files: [file] });
    const action = page.getByTestId("diff-file-0-mark-as-viewed");
    await expect.element(action).toBeDisabled();
    completeRead(JSON.stringify({ [file.path]: viewedFileRevision(file) }));
    await expect.element(action).toBeEnabled();
    await expect.element(action).toHaveAttribute("aria-selected", "true");
  });

  it("reports a failed read and can retry without losing the saved revision", async () => {
    await AsyncStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ [file.path]: viewedFileRevision(file) }),
    );
    vi.spyOn(AsyncStorage, "getItem").mockRejectedValueOnce(new Error("Storage unavailable"));
    mountReview({ storageKey: STORAGE_KEY, files: [file] });
    const action = page.getByTestId("diff-file-0-mark-as-viewed");
    await expect.element(page.getByTestId("diff-viewed-error")).toBeVisible();
    await expect.element(action).toBeDisabled();
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect.element(action).toBeEnabled();
    await expect.element(action).toHaveAttribute("aria-selected", "true");
  });

  it("waits for a pending write before publishing the viewed state", async () => {
    let completeWrite!: () => void;
    const originalWrite = AsyncStorage.setItem;
    vi.spyOn(AsyncStorage, "setItem").mockImplementationOnce(async (key, value) => {
      await new Promise<void>((resolve) => {
        completeWrite = resolve;
      });
      await originalWrite(key, value);
    });
    mountReview({ storageKey: STORAGE_KEY, files: [file] });
    const action = page.getByTestId("diff-file-0-mark-as-viewed");
    await expect.element(action).toBeEnabled();
    await action.click();
    await expect.element(action).toBeDisabled();
    await expect.element(action).toHaveAttribute("aria-selected", "false");
    completeWrite();
    await expect.element(action).toBeEnabled();
    await expect.element(action).toHaveAttribute("aria-selected", "true");
  });

  it("does not restore a previous comparison into the current one", async () => {
    await AsyncStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ [file.path]: viewedFileRevision(file) }),
    );
    const view = mountReview({ storageKey: STORAGE_KEY, files: [file] });
    await expect
      .element(page.getByTestId("diff-file-0-mark-as-viewed"))
      .toHaveAttribute("aria-selected", "true");
    view.rerenderReview({ storageKey: OTHER_KEY, files: [file] });
    await expect
      .element(page.getByTestId("diff-file-0-mark-as-viewed"))
      .toHaveAttribute("aria-selected", "false");
  });

  it("keeps the file unviewed and shows an error when storage rejects a write", async () => {
    mountReview({ storageKey: STORAGE_KEY, files: [file] });
    const action = page.getByTestId("diff-file-0-mark-as-viewed");
    await expect.element(action).toBeEnabled();
    vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });
    await action.click();
    await expect.element(page.getByTestId("diff-viewed-error")).toBeVisible();
    await expect.element(action).toHaveAttribute("aria-selected", "false");
    await expect.element(page.getByTestId("saved")).toHaveTextContent("false");
    await action.click();
    await expect.element(action).toHaveAttribute("aria-selected", "true");
    await expect.element(page.getByTestId("diff-viewed-error")).not.toBeInTheDocument();
  });
});
