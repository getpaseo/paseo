import type { FileReadResult } from "@getpaseo/client/internal/daemon-client";
import type { LiveFileSnapshot } from "../live-file/model";
import { afterEach, describe, expect, it } from "vitest";
import { __setAttachmentStoreForTests } from "@/attachments/store";
import { createLocalFileAttachmentStore } from "@/attachments/local-file-attachment-store";
import { createTestAttachmentFileSystem } from "@/attachments/test-attachment-file-system";
import {
  createFilePanePreview,
  FilePreviewLifecycleModel,
  type FilePanePreview,
  type FilePreviewLifecycleSnapshot,
} from "./model";

afterEach(() => __setAttachmentStoreForTests(null));

describe("createFilePanePreview", () => {
  it.each([
    ["recording.webm", "video/webm"],
    ["recording.mov", "video/quicktime"],
    ["recording.mp4", "video/mp4"],
  ])(
    "caches binary %s bytes with a playable MIME type and file extension",
    async (path, mimeType) => {
      const fileSystem = createTestAttachmentFileSystem();
      const store = createLocalFileAttachmentStore({
        storageType: "native-file",
        baseDirectoryName: "preview-assets",
        fileSystem,
        resolvePreviewUrl: async (attachment) => `file://${attachment.storageKey}`,
      });
      __setAttachmentStoreForTests(store);
      const bytes = new Uint8Array([0, 1, 2, 3]);
      const preview = await createFilePanePreview({
        ...file(),
        path,
        kind: "binary",
        mime: "application/octet-stream",
        size: bytes.length,
        bytes,
      });
      const attachment = preview?.mediaAttachment;
      expect(attachment).toMatchObject({ mimeType, fileName: path, byteSize: bytes.length });
      if (!attachment) throw new Error("Expected a cached video attachment");
      const url = await store.resolvePreviewUrl({ attachment });
      expect(url.endsWith(path.slice(path.lastIndexOf(".")))).toBe(true);
      expect(fileSystem.files.get(url)).toEqual(bytes);
      expect(preview?.file.kind).toBe("binary");
    },
  );

  it("does not cache arbitrary binary files for playback", async () => {
    const preview = await createFilePanePreview({
      ...file(),
      kind: "binary",
      mime: "application/octet-stream",
      path: "archive.zip",
    });
    expect(preview?.mediaAttachment).toBeNull();
  });
});

function previewFile(content: string) {
  return {
    kind: "text" as const,
    path: "file.ts",
    size: 7,
    encoding: "utf-8" as const,
    hasBom: false,
    modifiedAt: "2026-08-20T00:00:00.000Z",
    content,
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function file(revision = "revision-1", path = "file.ts"): FileReadResult {
  return {
    bytes: new TextEncoder().encode("preview"),
    mime: "text/plain",
    size: 7,
    path,
    kind: "text",
    modifiedAt: "2026-08-20T00:00:00.000Z",
    revision,
  };
}

function pending(): LiveFileSnapshot {
  return { observation: null, read: { status: "pending", requested: false } };
}

function completed(rawFile: FileReadResult): LiveFileSnapshot {
  return {
    observation: {
      status: "ready",
      file: rawFile,
      version: {
        status: "ready",
        cwd: "/workspace",
        path: rawFile.path,
        size: rawFile.size,
        modifiedAt: rawFile.modifiedAt,
        revision: rawFile.revision,
      },
    },
    read: { status: "idle" },
  };
}

function source(
  targetKey: string,
  snapshot: LiveFileSnapshot,
): {
  targetKey: string;
  liveFileSnapshot: LiveFileSnapshot;
} {
  return { targetKey, liveFileSnapshot: snapshot };
}

describe("FilePreviewLifecycleModel", () => {
  it("represents pending raw reads, preparation, ready previews, unsupported files, and conversion failures", async () => {
    const first = deferred<FilePanePreview | null>();
    const second = deferred<FilePanePreview | null>();
    const third = deferred<FilePanePreview | null>();
    const preparations = [first, second, third];
    const model = new FilePreviewLifecycleModel(() => preparations.shift()!.promise);
    const preview: FilePanePreview = {
      file: previewFile("preview"),
      mediaAttachment: null,
    };

    model.setSource(source("/workspace:file.ts", pending()));
    expect(model.getSnapshot()).toEqual({ status: "read_pending" });

    model.setSource(source("/workspace:file.ts", completed(file("one"))));
    expect(model.getSnapshot()).toEqual({ status: "preparing" });
    first.resolve(preview);
    await expectSnapshot(model, { status: "ready", preview });

    model.setSource(source("/workspace:file.ts", pending()));
    expect(model.getSnapshot()).toEqual({ status: "read_pending", preview });

    model.setSource(
      source("/workspace:file.ts", {
        observation: {
          status: "error",
          cwd: "/workspace",
          path: "file.ts",
          error: "Requested path is not a file",
        },
        read: { status: "pending", requested: true },
      }),
    );
    expect(model.getSnapshot()).toEqual({ status: "read_pending", preview });

    model.setSource(source("/workspace:file.ts", completed(file("two"))));
    expect(model.getSnapshot()).toEqual({ status: "preparing", preview });
    second.resolve(null);
    await expectSnapshot(model, { status: "unsupported" });

    model.setSource(source("/workspace:file.ts", completed(file("three"))));
    expect(model.getSnapshot()).toEqual({ status: "preparing" });
    third.reject(new Error("attachment failed"));
    await expectSnapshot(model, { status: "error", message: "attachment failed" });
  });

  it("does not publish a stale conversion after retargeting", async () => {
    const first = deferred<FilePanePreview | null>();
    const second = deferred<FilePanePreview | null>();
    const model = new FilePreviewLifecycleModel((rawFile) =>
      rawFile.revision === "one" ? first.promise : second.promise,
    );
    const nextPreview: FilePanePreview = {
      file: previewFile("two"),
      mediaAttachment: null,
    };

    model.setSource(source("/workspace:file.ts", completed(file("one"))));
    model.setSource(source("/workspace:second.ts", completed(file("two", "second.ts"))));
    first.resolve({ file: previewFile("one"), mediaAttachment: null });
    await Promise.resolve();
    expect(model.getSnapshot()).toEqual({ status: "preparing" });

    second.resolve(nextPreview);
    await expectSnapshot(model, { status: "ready", preview: nextPreview });
  });
});

async function expectSnapshot(
  model: FilePreviewLifecycleModel,
  expected: FilePreviewLifecycleSnapshot,
): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  expect(model.getSnapshot()).toEqual(expected);
}
