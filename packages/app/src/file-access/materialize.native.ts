import { File, Directory, Paths, type FileHandle } from "expo-file-system";
import { digestStringAsync, CryptoDigestAlgorithm } from "expo-crypto";
import * as Sharing from "expo-sharing";
import { requireOptionalNativeModule } from "expo-modules-core";
import { Platform } from "react-native";
import { z } from "zod";
import type { MaterializeInput, MaterializedFile } from "./types";
import type { FileReadMetadata } from "@getpaseo/client/internal/daemon-client";

interface NativeDocuments {
  open(uri: string, mime: string): Promise<void>;
  save(uri: string, name: string, mime: string): Promise<boolean>;
}
const nativeDocuments = requireOptionalNativeModule<NativeDocuments>("PaseoDocuments");
const cacheSchema = z.object({
  version: z.string().regex(/^[a-f0-9]{64}$/),
  metadata: z.object({
    path: z.string(),
    kind: z.enum(["text", "image", "binary"]),
    mime: z.string(),
    size: z.number().int().nonnegative(),
    modifiedAt: z.string(),
    revision: z.string().optional(),
  }),
});
const leases = new Map<string, number>();
const cacheBudget = 512 * 1024 * 1024;
let transferQueue: Promise<unknown> = Promise.resolve();

export async function materializeFile(input: MaterializeInput): Promise<MaterializedFile> {
  const queued = transferQueue.catch(() => {}).then(() => receiveFile(input));
  transferQueue = queued;
  return queued;
}

async function receiveFile(input: MaterializeInput): Promise<MaterializedFile> {
  if (input.signal?.aborted) throw new Error("File transfer canceled");
  const key = await digestStringAsync(CryptoDigestAlgorithm.SHA256, JSON.stringify(input.target));
  const directory = new Directory(Paths.cache, "paseo-documents", key);
  directory.create({ intermediates: true, idempotent: true });
  const name = input.target.path.replace(/\\/g, "/").split("/").pop() || "file";
  const manifest = new File(directory, "latest.json");
  const client = input.client;
  if (!client?.isConnected) {
    const offline = await readOfflineFile(input, directory, manifest, name);
    if (offline) return offline;
    throw new Error("The host is disconnected and this file has not been cached");
  }
  pruneCache();
  const partial = new File(
    directory,
    `${Date.now()}-${Math.random().toString(36).slice(2)}.partial`,
  );
  partial.create();
  let handle: FileHandle | null = partial.open();
  let received = 0;
  let total = 0;
  let lastProgress = 0;
  let finalMetadata: FileReadMetadata | null = null;
  let rejectAbort: (error: Error) => void = () => {};
  const onAbort = () => rejectAbort(new Error("File transfer canceled"));
  const abort = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  input.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const receive = client.readFileToSink({
      cwd: input.target.cwd,
      path: input.target.path,
      maxBytes: input.maxBytes ?? cacheBudget,
      signal: input.signal,
      sink: {
        begin(metadata) {
          if (input.signal?.aborted) throw new Error("File transfer canceled");
          total = metadata.size;
          pruneCache(total, partial.uri);
          input.onProgress?.(0, total);
        },
        write(bytes) {
          if (input.signal?.aborted) throw new Error("File transfer canceled");
          if (!handle) throw new Error("File transfer canceled");
          handle.writeBytes(bytes);
          received += bytes.byteLength;
          if (Date.now() - lastProgress > 100 || received === total) {
            lastProgress = Date.now();
            input.onProgress?.(received, total);
          }
        },
        end(metadata) {
          finalMetadata = metadata;
        },
      },
    });
    const metadata = await Promise.race([receive, abort]);
    if (!finalMetadata || received !== metadata.size) throw new Error("Incomplete file transfer");
    handle.close();
    handle = null;
    const version = await digestStringAsync(
      CryptoDigestAlgorithm.SHA256,
      metadata.revision ?? `${metadata.modifiedAt}:${metadata.size}`,
    );
    const versionDirectory = new Directory(directory, version);
    versionDirectory.create({ idempotent: true });
    const destination = new File(versionDirectory, name);
    if (destination.exists && destination.size !== metadata.size) destination.delete();
    if (destination.exists) partial.delete();
    else partial.move(destination);
    manifest.write(JSON.stringify({ version, metadata }));
    return lease({ ...metadata, name, uri: destination.uri });
  } catch (error) {
    handle?.close();
    handle = null;
    if (partial.exists) partial.delete();
    throw error;
  } finally {
    input.signal?.removeEventListener("abort", onAbort);
  }
}

async function readOfflineFile(
  input: MaterializeInput,
  directory: Directory,
  manifest: File,
  name: string,
): Promise<MaterializedFile | null> {
  if (!manifest.exists) return null;
  const cached = cacheSchema.parse(JSON.parse(await manifest.text()));
  const file = new File(directory, cached.version, name);
  if (!file.exists || file.size !== cached.metadata.size) return null;
  if (input.maxBytes && file.size > input.maxBytes) throw new Error("File is too large to display");
  return lease({ ...cached.metadata, name, uri: file.uri, offline: true });
}

function lease(file: Omit<MaterializedFile, "release">): MaterializedFile {
  leases.set(file.uri, (leases.get(file.uri) ?? 0) + 1);
  let released = false;
  return {
    ...file,
    release() {
      if (released) return;
      released = true;
      const count = (leases.get(file.uri) ?? 1) - 1;
      if (count) leases.set(file.uri, count);
      else leases.delete(file.uri);
    },
  };
}
function pruneCache(reserve = 0, protectedUri?: string) {
  const root = new Directory(Paths.cache, "paseo-documents");
  if (!root.exists) return;
  const files: File[] = [];
  const visit = (directory: Directory) => {
    for (const entry of directory.list()) {
      if (entry instanceof Directory) visit(entry);
      else files.push(entry);
    }
  };
  visit(root);
  let size = files.reduce((sum, file) => sum + file.size, 0);
  const stale = files
    .filter(
      (file) => !leases.has(file.uri) && file.uri !== protectedUri && file.name !== "latest.json",
    )
    .sort((a, b) => (a.modificationTime ?? 0) - (b.modificationTime ?? 0));
  for (const file of stale) {
    if (size + reserve <= cacheBudget) break;
    const bytes = file.size;
    file.delete();
    size -= bytes;
  }
  if (size + reserve > cacheBudget)
    throw new Error("Document cache is full. Close other previews and retry.");
}

export async function openMaterializedFile(
  file: MaterializedFile,
  _application?: string,
): Promise<void> {
  if (Platform.OS !== "android" || !nativeDocuments)
    throw new Error(
      "External opening requires the enhanced Android build. You can still share this file.",
    );
  await nativeDocuments.open(file.uri, file.mime);
}
export async function saveMaterializedFile(file: MaterializedFile): Promise<void> {
  if (!nativeDocuments)
    throw new Error("Saving requires the enhanced Android build. You can still share this file.");
  await nativeDocuments.save(file.uri, file.name, file.mime);
}
export async function shareMaterializedFile(file: MaterializedFile): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) throw new Error("File sharing is unavailable.");
  await Sharing.shareAsync(file.uri, { mimeType: file.mime, dialogTitle: file.name });
}
