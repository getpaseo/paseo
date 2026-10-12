import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { DaemonClient, FileReadMetadata } from "@getpaseo/client/internal/daemon-client";
import type { MaterializeInput } from "./types";

const state = vi.hoisted(() => ({ root: "" }));
// Run the cache/transfer lifecycle against a real temporary filesystem. This
// adapter implements the Expo filesystem API used here; it is not a device test.
vi.mock("expo-file-system", async () => {
  const nativeFs = await import("node:fs");
  const nativePath = await import("node:path");
  const { fileURLToPath: nativeFilePath, pathToFileURL } = await import("node:url");
  function location(parts: (string | { uri: string })[]) {
    return nativePath.join(
      ...parts.map((part) => {
        const value = typeof part === "string" ? part : part.uri;
        return value.startsWith("file:") ? nativeFilePath(value) : value;
      }),
    );
  }
  class File {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = pathToFileURL(location(parts)).href;
    }
    get local() {
      return nativeFilePath(this.uri);
    }
    get exists() {
      return nativeFs.existsSync(this.local);
    }
    get name() {
      return nativePath.basename(this.local);
    }
    get size() {
      return nativeFs.statSync(this.local).size;
    }
    get modificationTime() {
      return nativeFs.statSync(this.local).mtimeMs;
    }
    create() {
      nativeFs.closeSync(nativeFs.openSync(this.local, "wx"));
    }
    delete() {
      nativeFs.unlinkSync(this.local);
    }
    write(value: string) {
      nativeFs.writeFileSync(this.local, value);
    }
    async text() {
      return nativeFs.readFileSync(this.local, "utf8");
    }
    move(destination: File) {
      nativeFs.renameSync(this.local, destination.local);
      this.uri = destination.uri;
    }
    open() {
      const descriptor = nativeFs.openSync(this.local, "r+");
      return {
        writeBytes(bytes: Uint8Array) {
          nativeFs.writeSync(descriptor, bytes);
        },
        close() {
          nativeFs.closeSync(descriptor);
        },
      };
    }
  }
  class Directory {
    uri: string;
    constructor(...parts: (string | { uri: string })[]) {
      this.uri = pathToFileURL(location(parts)).href;
    }
    get local() {
      return nativeFilePath(this.uri);
    }
    get exists() {
      return nativeFs.existsSync(this.local);
    }
    create() {
      nativeFs.mkdirSync(this.local, { recursive: true });
    }
    list() {
      return fs
        .readdirSync(this.local, { withFileTypes: true })
        .map((entry) =>
          entry.isDirectory() ? new Directory(this, entry.name) : new File(this, entry.name),
        );
    }
  }
  return {
    File,
    Directory,
    Paths: {
      get cache() {
        return state.root;
      },
    },
  };
});
vi.mock("expo-crypto", async () => {
  const { createHash } = await import("node:crypto");
  return {
    CryptoDigestAlgorithm: { SHA256: "sha256" },
    digestStringAsync: async (_algorithm: string, value: string) =>
      createHash("sha256").update(value).digest("hex"),
  };
});
vi.mock("expo-sharing", () => ({}));
vi.mock("expo-modules-core", () => ({ requireOptionalNativeModule: () => null }));
vi.mock("react-native", () => ({ Platform: { OS: "android" } }));
import { materializeFile } from "./materialize.native";

const target = { serverId: "host-one", cwd: "/task", path: "季度 报告.pdf" };
const bytes = new TextEncoder().encode("synthetic PDF document bytes");
const metadata = (revision = "v1"): FileReadMetadata => ({
  path: target.path,
  kind: "binary",
  mime: "application/pdf",
  size: bytes.length,
  modifiedAt: "2026-10-11T00:00:00Z",
  revision,
});
type SinkInput = Parameters<DaemonClient["readFileToSink"]>[0];
function client(read?: (input: SinkInput) => Promise<FileReadMetadata>) {
  return {
    isConnected: true,
    readFileToSink: vi.fn(
      read ??
        (async ({ sink }) => {
          const info = metadata();
          sink.begin(info);
          sink.write(bytes.slice(0, 9));
          sink.write(bytes.slice(9));
          sink.end(info);
          return info;
        }),
    ),
  };
}
function input(
  source: ReturnType<typeof client>,
  extra: Partial<MaterializeInput> = {},
): MaterializeInput {
  return { target, client: source as unknown as DaemonClient, ...extra };
}
function partials() {
  return fs
    .readdirSync(state.root, { recursive: true })
    .filter((entry) => String(entry).endsWith(".partial"));
}
beforeEach(() => {
  state.root = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-android-cache-"));
});
afterEach(() => {
  fs.rmSync(state.root, { recursive: true, force: true });
});

test("writes binary chunks intact, preserves a Unicode name, and reads the completed copy offline", async () => {
  const source = client();
  const progress = vi.fn();
  const file = await materializeFile(input(source, { onProgress: progress }));
  expect(fs.readFileSync(fileURLToPath(file.uri))).toEqual(Buffer.from(bytes));
  expect(file.name).toBe(target.path);
  expect(progress).toHaveBeenLastCalledWith(bytes.length, bytes.length);
  expect(partials()).toEqual([]);
  source.isConnected = false;
  const offline = await materializeFile(input(source));
  expect(offline.offline).toBe(true);
  expect(offline.uri).toBe(file.uri);
  expect(source.readFileToSink).toHaveBeenCalledTimes(1);
  file.release();
  file.release();
  offline.release();
});

test("isolates identical file paths by host and working directory", async () => {
  const source = client();
  const files = await Promise.all([
    materializeFile(input(source)),
    materializeFile(input(source, { target: { ...target, serverId: "host-two" } })),
    materializeFile(input(source, { target: { ...target, cwd: "/other-task" } })),
  ]);
  expect(new Set(files.map((file) => file.uri)).size).toBe(3);
  files.forEach((file) => file.release());
});

test("restores a persisted PDF cache before a host client exists after an offline restart", async () => {
  const source = client();
  const file = await materializeFile(input(source));
  const uri = file.uri;
  file.release();
  const offline = await materializeFile(input(source, { client: null }));
  expect(offline.offline).toBe(true);
  expect(offline.uri).toBe(uri);
  expect(fs.readFileSync(fileURLToPath(offline.uri))).toEqual(Buffer.from(bytes));
  expect(source.readFileToSink).toHaveBeenCalledTimes(1);
  offline.release();
  await expect(
    materializeFile(input(source, { client: null, target: { ...target, path: "uncached.pdf" } })),
  ).rejects.toThrow("has not been cached");
});

test("keeps the last completed version when a new transfer fails and deletes its partial file", async () => {
  const source = client();
  const previous = await materializeFile(input(source));
  source.readFileToSink.mockImplementationOnce(async ({ sink }) => {
    sink.begin(metadata("v2"));
    sink.write(bytes.slice(0, 9));
    throw new Error("connection lost");
  });
  await expect(materializeFile(input(source))).rejects.toThrow("connection lost");
  expect(partials()).toEqual([]);
  source.isConnected = false;
  const offline = await materializeFile(input(source));
  expect(offline.uri).toBe(previous.uri);
  expect(fs.readFileSync(fileURLToPath(offline.uri))).toEqual(Buffer.from(bytes));
  previous.release();
  offline.release();
});

test("canceling an active transfer closes and removes the incomplete copy", async () => {
  const controller = new AbortController();
  const source = client(async ({ sink, signal }) => {
    sink.begin(metadata());
    sink.write(bytes.slice(0, 9));
    controller.abort();
    signal?.throwIfAborted();
    return metadata();
  });
  await expect(materializeFile(input(source, { signal: controller.signal }))).rejects.toThrow();
  expect(partials()).toEqual([]);
  expect(
    fs
      .readdirSync(state.root, { recursive: true })
      .some((name) => String(name).endsWith("latest.json")),
  ).toBe(false);
});

test("an already canceled request performs no filesystem or network work", async () => {
  const source = client();
  const controller = new AbortController();
  controller.abort();
  await expect(materializeFile(input(source, { signal: controller.signal }))).rejects.toThrow();
  expect(source.readFileToSink).not.toHaveBeenCalled();
  expect(fs.readdirSync(state.root)).toEqual([]);
});

test("accepts a Hermes-style signal without throwIfAborted and still rejects cancellation", async () => {
  const source = client();
  const controller = new AbortController();
  Object.defineProperty(controller.signal, "throwIfAborted", { value: undefined });
  const file = await materializeFile(input(source, { signal: controller.signal }));
  expect(fs.readFileSync(fileURLToPath(file.uri))).toEqual(Buffer.from(bytes));
  file.release();
  controller.abort();
  await expect(materializeFile(input(source, { signal: controller.signal }))).rejects.toThrow(
    "File transfer canceled",
  );
  expect(source.readFileToSink).toHaveBeenCalledTimes(1);
  expect(partials()).toEqual([]);
});

test("clears stale cache data to honor the budget while preserving a document still open", async () => {
  const source = client();
  const opened = await materializeFile(input(source));
  const stale = path.join(state.root, "paseo-documents", "obsolete.bin");
  fs.writeFileSync(stale, "");
  fs.truncateSync(stale, 512 * 1024 * 1024);
  const next = await materializeFile(input(source, { target: { ...target, path: "next.pdf" } }));
  expect(fs.existsSync(stale)).toBe(false);
  expect(fs.existsSync(fileURLToPath(opened.uri))).toBe(true);
  opened.release();
  next.release();
});

test("refuses a transfer that cannot fit beside pinned documents and preserves them", async () => {
  const source = client();
  const opened = await materializeFile(input(source));
  source.readFileToSink.mockImplementationOnce(async ({ sink }) => {
    sink.begin({ ...metadata("large"), size: 512 * 1024 * 1024 });
    throw new Error("budget should reject before receiving bytes");
  });
  await expect(
    materializeFile(input(source, { target: { ...target, path: "large.pdf" } })),
  ).rejects.toThrow("cache is full");
  expect(partials()).toEqual([]);
  expect(fs.existsSync(fileURLToPath(opened.uri))).toBe(true);
  opened.release();
});
