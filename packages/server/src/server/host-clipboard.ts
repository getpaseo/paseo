import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execCommand } from "../utils/spawn.js";
import type { TerminalManager } from "../terminal/terminal-manager.js";

export interface TerminalImageInput {
  terminalId: string;
  mimeType: "image/png" | "image/jpeg";
  dataBase64: string;
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const stores = new WeakMap<TerminalManager, Map<string, TerminalImageStore>>();

export function getTerminalImageStore(home: string, manager: TerminalManager): TerminalImageStore {
  let homes = stores.get(manager);
  if (!homes) {
    homes = new Map();
    stores.set(manager, homes);
  }
  let store = homes.get(home);
  if (!store) {
    store = new TerminalImageStore({
      directory: join(home, "terminal-images"),
      isActive: (id) => Boolean(manager.getTerminal(id)),
    });
    homes.set(home, store);
  }
  return store;
}

interface ImageStoreOptions {
  directory: string;
  isActive: (terminalId: string) => boolean;
  now?: () => number;
  maxBytes?: number;
  maxTerminalBytes?: number;
  maxFiles?: number;
  retentionMs?: number;
}

/**
 * Daemon-owned, not socket-owned: reconnects must not invalidate a pending paste.
 * Active files are never evicted. Inactive directories get a persisted retirement
 * time when next observed, then a seven-day grace period. Reconnecting/reactivating
 * cancels retirement. Sweeping is opportunistic on subsequent image requests.
 * No TUI consumption acknowledgement exists; do not turn an RPC or key-delivery
 * acknowledgement into permission to delete a file.
 */
export class TerminalImageStore {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: ImageStoreOptions) {}

  save(input: TerminalImageInput): Promise<string> {
    const operation = this.queue.then(() => this.saveQueued(input));
    this.queue = operation.catch(() => {});
    return operation;
  }

  private async saveQueued(input: TerminalImageInput): Promise<string> {
    const bytes = decodeImage(input);
    await privateDirectory(this.options.directory);
    const usage = await this.sweepAndMeasure(input.terminalId);
    if (
      usage.bytes + bytes.length > (this.options.maxBytes ?? 256 * 1024 * 1024) ||
      usage.terminalBytes + bytes.length > (this.options.maxTerminalBytes ?? 64 * 1024 * 1024) ||
      usage.files >= (this.options.maxFiles ?? 1024)
    ) {
      throw new Error("Terminal image storage is full; retained images were not deleted");
    }
    if (!this.options.isActive(input.terminalId)) throw new Error("Terminal no longer exists");
    const directory = join(this.options.directory, directoryName(input.terminalId));
    await privateDirectory(directory);
    const ownerPath = join(directory, "terminal.json");
    if (metadataOwner(await readMetadata(ownerPath)) !== input.terminalId) {
      await writeMetadata(ownerPath, { terminalId: input.terminalId });
    }
    const path = join(
      directory,
      `${randomUUID()}.${input.mimeType === "image/png" ? "png" : "jpg"}`,
    );
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    return path;
  }

  private async sweepAndMeasure(terminalId: string) {
    const now = (this.options.now ?? Date.now)();
    const usage = { bytes: 0, terminalBytes: 0, files: 0 };
    for (const entry of await readdir(this.options.directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
      const directory = join(this.options.directory, entry.name);
      const ownerPath = join(directory, "terminal.json");
      let owner = metadataOwner(await readMetadata(ownerPath));
      if (owner !== undefined && directoryName(owner) !== entry.name) owner = undefined;
      const matchesRequestedTerminal = entry.name === directoryName(terminalId);
      let recoveredOwner = false;
      if (owner === undefined && matchesRequestedTerminal) {
        owner = terminalId;
        await writeMetadata(ownerPath, { terminalId });
        recoveredOwner = true;
      }
      // An unreadable owner cannot establish inactivity. Keep its images and
      // include them in quotas until ownership can be recovered safely.
      if (owner !== undefined) {
        const retiredPath = join(directory, "retired.json");
        if (this.options.isActive(owner)) {
          await rm(retiredPath, { force: true });
        } else {
          const retiredAt = await readOrStartRetirement(retiredPath, now, recoveredOwner);
          if (now - retiredAt >= (this.options.retentionMs ?? RETENTION_MS)) {
            await rm(directory, { recursive: true, force: true });
            continue;
          }
        }
      }
      for (const file of await readdir(directory, { withFileTypes: true })) {
        if (!file.isFile() || !/\.(png|jpg)$/.test(file.name)) continue;
        const info = await lstat(join(directory, file.name));
        usage.bytes += info.size;
        usage.files++;
        if (matchesRequestedTerminal) usage.terminalBytes += info.size;
      }
    }
    return usage;
  }
}

async function readOrStartRetirement(path: string, now: number, reset: boolean): Promise<number> {
  const metadata = await readMetadata(path);
  if (!reset && typeof metadata === "number" && Number.isFinite(metadata)) return metadata;
  await writeMetadata(path, now);
  return now;
}

async function readMetadata(path: string): Promise<unknown> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return JSON.parse(contents) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

function metadataOwner(metadata: unknown): string | undefined {
  return typeof metadata === "object" &&
    metadata !== null &&
    "terminalId" in metadata &&
    typeof metadata.terminalId === "string"
    ? metadata.terminalId
    : undefined;
}

async function writeMetadata(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600, flush: true });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function directoryName(id: string): string {
  return createHash("sha256").update(id).digest("hex");
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Unsafe terminal image directory");
  if (process.platform === "win32") {
    // chmod does not establish Windows confidentiality. Replace the DACL rather
    // than merely disabling inheritance (which could retain permissive ACEs).
    // The path is data in the child environment, never interpolated into code.
    await execCommand(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        [
          "$ErrorActionPreference = 'Stop'",
          "$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User",
          "$acl = New-Object System.Security.AccessControl.DirectorySecurity",
          "$acl.SetOwner($sid)",
          "$acl.SetAccessRuleProtection($true, $false)",
          "$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')",
          "$acl.AddAccessRule($rule)",
          "[System.IO.Directory]::SetAccessControl($env:PASEO_IMAGE_DIRECTORY, $acl)",
        ].join("; "),
      ],
      { shell: false, timeout: 15000, envOverlay: { PASEO_IMAGE_DIRECTORY: path } },
    );
  } else {
    await chmod(path, 0o700);
  }
}

function decodeImage(input: TerminalImageInput): Buffer {
  if (input.dataBase64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) {
    throw new Error("Clipboard image too large: limit is 10 MiB");
  }
  const bytes = Buffer.from(input.dataBase64, "base64");
  if (bytes.toString("base64") !== input.dataBase64) throw new Error("Invalid image encoding");
  const signature = input.mimeType === "image/png" ? "89504e470d0a1a0a" : "ffd8ff";
  if (!bytes.subarray(0, signature.length / 2).equals(Buffer.from(signature, "hex"))) {
    throw new Error("Clipboard payload does not match its image type");
  }
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error("Clipboard image too large: limit is 10 MiB");
  return bytes;
}

/**
 * This is a file-drop reference for a bracketed-paste-aware TUI, not a shell
 * command. Codex and OpenCode accept quoted paths and file URLs. Double quotes
 * preserve spaces/apostrophes without POSIX apostrophe escapes on Windows.
 * Use an encoded URL for control characters or shell interpolation characters;
 * never strip characters from the actual filename or infer the host from the UI.
 */
export function terminalImageReference(
  path: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const needsUrl =
    /["$`%!^&|<>]/.test(path) ||
    [...path].some((character) => character.charCodeAt(0) < 32) ||
    (platform !== "win32" && path.includes("\\"));
  return needsUrl ? pathToFileURL(path, { windows: platform === "win32" }).href : `"${path}"`;
}
