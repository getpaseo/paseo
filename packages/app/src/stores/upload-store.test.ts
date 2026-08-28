import { beforeEach, describe, expect, test } from "vitest";

// No module mocks: i18n loads cleanly here, and the daemon calls arrive through an
// injected uploadEntry port.
import { useUploadStore } from "./upload-store";

const file = (fileName: string, body: string) => ({
  fileName,
  mimeType: "text/plain",
  bytes: new TextEncoder().encode(body),
});

beforeEach(() => {
  useUploadStore.setState({ uploads: new Map(), activeUploadId: null });
});

describe("upload store", () => {
  test("uploads each picked file into the target folder", async () => {
    const calls: Array<{ path: string; overwrite: string }> = [];

    await useUploadStore.getState().startUploads({
      serverId: "srv",
      scopeId: "scope",
      parentPath: "assets",
      files: [file("a.txt", "one"), file("b.txt", "two")],
      uploadEntry: async ({ path, overwrite }) => {
        calls.push({ path, overwrite });
        return { path, size: 3 };
      },
    });

    expect(calls).toEqual([
      { path: "assets/a.txt", overwrite: "rename" },
      { path: "assets/b.txt", overwrite: "rename" },
    ]);
    const statuses = [...useUploadStore.getState().uploads.values()].map((u) => u.status);
    expect(statuses).toEqual(["complete", "complete"]);
  });

  test("joins paths correctly at the workspace root", async () => {
    const paths: string[] = [];
    await useUploadStore.getState().startUploads({
      serverId: "srv",
      scopeId: "scope",
      parentPath: ".",
      files: [file("root.txt", "x")],
      uploadEntry: async ({ path }) => {
        paths.push(path);
        return { path, size: 1 };
      },
    });
    expect(paths).toEqual(["root.txt"]);
  });

  test("never clobbers: the daemon is asked to rename on a collision", async () => {
    let seen = "";
    await useUploadStore.getState().startUploads({
      serverId: "srv",
      scopeId: "scope",
      parentPath: ".",
      files: [file("a.txt", "x")],
      uploadEntry: async ({ path, overwrite }) => {
        seen = overwrite;
        return { path, size: 1 };
      },
    });
    expect(seen).toBe("rename");
  });

  test("one failure does not stop the remaining files", async () => {
    await useUploadStore.getState().startUploads({
      serverId: "srv",
      scopeId: "scope",
      parentPath: ".",
      files: [file("bad.txt", "x"), file("good.txt", "y")],
      uploadEntry: async ({ path }) => {
        if (path === "bad.txt") {
          throw new Error("Upload is too large.");
        }
        return { path, size: 1 };
      },
    });

    const uploads = [...useUploadStore.getState().uploads.values()];
    expect(uploads.map((u) => u.status)).toEqual(["error", "complete"]);
    expect(uploads[0].message).toBe("Upload is too large.");
  });

  test("refreshes the folder once, only when something landed", async () => {
    const refreshed: string[] = [];
    await useUploadStore.getState().startUploads({
      serverId: "srv",
      scopeId: "scope",
      parentPath: "assets",
      files: [file("a.txt", "x")],
      uploadEntry: async ({ path }) => ({ path, size: 1 }),
      onUploaded: (parentPath) => refreshed.push(parentPath),
    });
    expect(refreshed).toEqual(["assets"]);

    refreshed.length = 0;
    await useUploadStore.getState().startUploads({
      serverId: "srv",
      scopeId: "scope",
      parentPath: "assets",
      files: [file("a.txt", "x")],
      uploadEntry: async () => {
        throw new Error("nope");
      },
      onUploaded: (parentPath) => refreshed.push(parentPath),
    });
    expect(refreshed).toEqual([]);
  });

  test("reports completed progress against the real byte length", async () => {
    await useUploadStore.getState().startUploads({
      serverId: "srv",
      scopeId: "scope",
      parentPath: ".",
      files: [file("a.txt", "hello")],
      uploadEntry: async ({ path }) => ({ path, size: 5 }),
    });
    const upload = [...useUploadStore.getState().uploads.values()][0];
    expect(upload.progress).toMatchObject({ percent: 1, bytesWritten: 5, totalBytes: 5 });
  });

  test("a folder pick keeps its tree shape and creates missing directories", async () => {
    const calls: Array<{ path: string; overwrite: string; mkdir?: boolean }> = [];

    await useUploadStore.getState().startUploads({
      serverId: "srv",
      scopeId: "scope",
      parentPath: "dest",
      files: [
        { ...file("a.txt", "one"), relativePath: "site/a.txt" },
        { ...file("b.txt", "two"), relativePath: "site/nested/b.txt" },
      ],
      uploadEntry: async ({ path, overwrite, createMissingDirectories }) => {
        calls.push({ path, overwrite, mkdir: createMissingDirectories });
        return { path, size: 3 };
      },
    });

    expect(calls).toEqual([
      { path: "dest/site/a.txt", overwrite: "fail", mkdir: true },
      { path: "dest/site/nested/b.txt", overwrite: "fail", mkdir: true },
    ]);
  });

  test("never asks the daemon to replace, in either shape", async () => {
    const modes: string[] = [];
    await useUploadStore.getState().startUploads({
      serverId: "srv",
      scopeId: "scope",
      parentPath: ".",
      files: [file("flat.txt", "x"), { ...file("deep.txt", "y"), relativePath: "site/deep.txt" }],
      uploadEntry: async ({ path, overwrite }) => {
        modes.push(overwrite);
        return { path, size: 1 };
      },
    });
    expect(modes).not.toContain("replace");
    expect(modes).toEqual(["rename", "fail"]);
  });

  test("a flat pick still renames rather than creating directories", async () => {
    const calls: Array<{ overwrite: string; mkdir?: boolean }> = [];
    await useUploadStore.getState().startUploads({
      serverId: "srv",
      scopeId: "scope",
      parentPath: ".",
      files: [file("a.txt", "x")],
      uploadEntry: async ({ path, overwrite, createMissingDirectories }) => {
        calls.push({ overwrite, mkdir: createMissingDirectories });
        return { path, size: 1 };
      },
    });
    expect(calls).toEqual([{ overwrite: "rename", mkdir: false }]);
  });

  test("cancelling one upload abandons the rest of the batch", async () => {
    const attempted: string[] = [];

    const started = useUploadStore.getState().startUploads({
      serverId: "srv",
      scopeId: "scope",
      parentPath: ".",
      files: [file("first.txt", "a"), file("second.txt", "b"), file("third.txt", "c")],
      uploadEntry: async ({ path, signal }) => {
        attempted.push(path);
        if (path === "first.txt") {
          await new Promise<void>((resolve) => {
            signal?.addEventListener("abort", () => resolve());
          });
          throw new Error("Upload cancelled.");
        }
        return { path, size: 1 };
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    const inFlight = [...useUploadStore.getState().uploads.values()][0];
    useUploadStore.getState().cancelUpload(inFlight.id);
    await started;

    // Cancelling the first file must not let the next one start.
    expect(attempted).toEqual(["first.txt"]);
    const statuses = [...useUploadStore.getState().uploads.values()].map((u) => u.status);
    expect(statuses).toEqual(["error"]);
  });
});
