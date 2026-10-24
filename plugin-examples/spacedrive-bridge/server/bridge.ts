import { mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { SpacedriveDaemon } from "./daemon.js";

const MAX_BYTES = 200_000_000;
const daemon = new SpacedriveDaemon();

function safeDestination(destination: string): string {
  const resolved = path.resolve(destination);
  const cacheRoot = path.resolve(
    process.env.PASEO_REMOTE_CACHE ?? path.join(process.env.LOCALAPPDATA ?? process.cwd(), "Paseo", "remote-cache"),
  );
  const relative = path.relative(cacheRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Destination must be inside the Paseo remote-cache directory");
  }
  return resolved;
}

export async function status() {
  return daemon.ensureRunning();
}

export async function search(libraryId: string, query: string, limit: number) {
  const result = await daemon.call("query:search.files", { query, limit }, libraryId);
  return { items: Array.isArray(result) ? result : ((result as { items?: unknown[] })?.items ?? []) };
}

export async function copyToLocal(input: { libraryId: string; ref: { deviceSlug: string; locationId: string; relativePath: string; size?: number; sha256?: string }; destination: string; maxBytes: number }) {
  const destination = safeDestination(input.destination);
  if (input.ref.size && input.ref.size > Math.min(input.maxBytes, MAX_BYTES)) return { ok: false, error: "file-too-large" };
  await mkdir(path.dirname(destination), { recursive: true });
  const partial = `${destination}.part`;
  const sourcePath = input.ref.relativePath.replaceAll("\\", "/");
  await daemon.call("action:files.copy.input", {
    sources: { paths: [{ Physical: { device_slug: input.ref.deviceSlug, path: sourcePath } }] },
    destination: { Physical: { device_slug: "local", path: path.dirname(partial) } },
    options: {
      overwrite: true,
      verify_checksum: true,
      preserve_timestamps: true,
      delete_after_copy: false,
      move_mode: null,
      copy_method: "Auto",
      conflict_resolution: "Overwrite",
    },
  }, input.libraryId);
  const copiedPath = path.join(path.dirname(partial), path.basename(sourcePath));
  await rename(copiedPath, destination);
  const metadata = await stat(destination);
  if (metadata.size > Math.min(input.maxBytes, MAX_BYTES)) return { ok: false, error: "file-too-large" };
  return { ok: true, path: destination };
}
