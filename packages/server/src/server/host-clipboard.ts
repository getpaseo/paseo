import type { Dirent } from "node:fs";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import {
  terminalFileKey,
  type TerminalFileInventory,
} from "../terminal/terminal-file-lifecycle.js";
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

export function getTerminalImageStore(
  home: string,
  manager: TerminalManager,
  onError?: (error: unknown) => void,
): TerminalImageStore {
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
      lifecycle: manager.fileLifecycle,
    });
    homes.set(home, store);
    store.start(onError);
  }
  return store;
}

interface ImageFileSystem {
  chmod: typeof chmod;
  lstat: typeof lstat;
  mkdir: typeof mkdir;
  readFile: typeof readFile;
  rename: typeof rename;
  rm: typeof rm;
  writeFile: typeof writeFile;
  readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;
}

export const terminalImageFileSystem: ImageFileSystem = {
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
};

interface ImageStoreOptions {
  directory: string;
  filesystem?: ImageFileSystem;
  lifecycle?: TerminalFileInventory;
  onMaintenanceError?: (error: unknown) => void;
  isActive: (terminalId: string) => boolean;
  now?: () => number;
  maxBytes?: number;
  maxTerminalBytes?: number;
  maxFiles?: number;
  retentionMs?: number;
  maintenanceIntervalMs?: number;
}

interface DirectoryUsage {
  bytes: number;
  files: number;
  uploads: number;
}

/** Disk is the restart source of truth. After startup, reservations are the source
 * of truth for this daemon's private store. Maintenance never queues uploads. */
export class TerminalImageStore {
  private readonly usage = new Map<string, DirectoryUsage>();
  private bytes = 0;
  private files = 0;
  private readiness: Promise<void> | undefined;
  private readonly uploads = new Map<string, Promise<unknown>>();
  private readonly pendingMaintenance = new Set<string>();
  private readonly reactivated = new Map<string, number>();
  private activityVersion = 0;
  private maintenance: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private unsubscribe: (() => void) | undefined;
  private stopped = false;

  private readonly fs: ImageFileSystem;

  constructor(private readonly options: ImageStoreOptions) {
    this.fs = options.filesystem ?? terminalImageFileSystem;
  }

  start(onError = this.options.onMaintenanceError ?? (() => {})): void {
    if (this.timer || this.stopped) return;
    const schedule = (key?: string) => {
      void this.sweep(key).catch(onError);
    };
    this.unsubscribe = this.options.lifecycle?.subscribe((key) => {
      if (typeof this.options.lifecycle?.owner(key) === "string")
        this.reactivated.set(key, ++this.activityVersion);
      schedule(key);
    });
    // Start accounting before accepting connections. Only image uploads await it.
    schedule();
    this.timer = setInterval(schedule, this.options.maintenanceIntervalMs ?? 60_000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.unsubscribe?.();
    this.pendingMaintenance.clear();
    await this.maintenance?.catch(() => {});
  }

  private initialize(): Promise<void> {
    if (!this.readiness) {
      this.readiness = this.measure().catch((error: unknown) => {
        this.readiness = undefined;
        throw error;
      });
    }
    return this.readiness;
  }

  private async measure(): Promise<void> {
    await privateDirectory(this.options.directory, this.fs);
    const measured = new Map<string, DirectoryUsage>();
    let bytes = 0,
      files = 0;
    for (const entry of await this.fs.readdir(this.options.directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
      const usage = { bytes: 0, files: 0, uploads: 0 };
      const directory = join(this.options.directory, entry.name);
      for (const file of await this.fs.readdir(directory, { withFileTypes: true })) {
        if (!file.isFile() || !/\.(png|jpg)$/.test(file.name)) continue;
        usage.bytes += (await this.fs.lstat(join(directory, file.name))).size;
        usage.files++;
      }
      measured.set(entry.name, usage);
      bytes += usage.bytes;
      files += usage.files;
      await yieldToEventLoop();
    }
    for (const [key, usage] of measured) this.usage.set(key, usage);
    this.bytes = bytes;
    this.files = files;
  }

  save(input: TerminalImageInput): Promise<string> {
    // Serialize only uploads for the same terminal, never a sweep or other PTYs.
    const key = terminalFileKey(input.terminalId);
    const operation = (this.uploads.get(key) ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.saveImage(input))
      .catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOSPC")
          throw new Error("Host disk is full; cannot upload the image", { cause: error });
        throw error;
      });
    this.uploads.set(key, operation);
    void operation
      .finally(() => {
        if (this.uploads.get(key) === operation) this.uploads.delete(key);
      })
      .catch(() => {});
    return operation;
  }

  private async saveImage(input: TerminalImageInput): Promise<string> {
    const bytes = decodeImage(input);
    await this.initialize();
    if (this.stopped || !this.options.isActive(input.terminalId))
      throw new Error("Terminal no longer exists");
    const key = terminalFileKey(input.terminalId);
    const usage = this.usage.get(key) ?? { bytes: 0, files: 0, uploads: 0 };
    this.usage.set(key, usage);
    const directory = join(this.options.directory, key);
    // Repair this owner's metadata even if its quota is already full.
    usage.uploads++;
    let reserved = false;
    let imagePath: string | undefined;
    try {
      await privateDirectory(directory, this.fs);
      const ownerPath = join(directory, "terminal.json");
      if (metadataOwner(await readMetadata(ownerPath, this.fs)) !== input.terminalId) {
        await writeMetadata(ownerPath, { terminalId: input.terminalId }, this.fs);
      }
      await this.fs.rm(join(directory, "retired.json"), { force: true });
      if (
        this.bytes + bytes.length > (this.options.maxBytes ?? 256 * 1024 * 1024) ||
        usage.bytes + bytes.length > (this.options.maxTerminalBytes ?? 64 * 1024 * 1024) ||
        this.files >= (this.options.maxFiles ?? 1024)
      )
        throw new Error("Terminal image storage limit reached; retained images were not deleted");
      // No await between checking and reserving the shared limits.
      this.bytes += bytes.length;
      this.files++;
      usage.bytes += bytes.length;
      usage.files++;
      reserved = true;
      imagePath = join(
        directory,
        `${randomUUID()}.${input.mimeType === "image/png" ? "png" : "jpg"}`,
      );
      await this.fs.writeFile(imagePath, bytes, { flag: "wx", mode: 0o600 });
      return imagePath;
    } catch (error) {
      // A failed write can leave a partial file. Release its reservation only
      // after confirmed removal; otherwise conservatively charge it until cleanup.
      if (reserved && imagePath) {
        try {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST")
            await this.fs.rm(imagePath, { force: true });
          this.bytes -= bytes.length;
          this.files--;
          usage.bytes -= bytes.length;
          usage.files--;
        } catch {
          /* Keep the reservation. Restart remeasures actual bytes. */
        }
      }
      throw error;
    } finally {
      usage.uploads--;
    }
  }

  /** Called by exit notifications and a low-frequency timer, never by uploads. */
  async sweep(key?: string): Promise<void> {
    await this.initialize();
    if (this.stopped) return;
    if (!key && this.maintenance) return this.maintenance;
    if (key) this.pendingMaintenance.add(key);
    else for (const name of this.usage.keys()) this.pendingMaintenance.add(name);
    if (!this.maintenance) {
      this.maintenance = this.drainMaintenance().finally(() => {
        this.maintenance = undefined;
      });
    }
    return this.maintenance;
  }

  private async drainMaintenance(): Promise<void> {
    while (!this.stopped && this.pendingMaintenance.size) {
      const key = this.pendingMaintenance.values().next().value!;
      this.pendingMaintenance.delete(key);
      try {
        await this.maintainDirectory(key);
      } finally {
        await yieldToEventLoop();
      }
    }
  }

  private async maintainDirectory(key: string): Promise<void> {
    const usage = this.usage.get(key);
    if (!usage) {
      this.reactivated.delete(key);
      return;
    }
    if (usage.uploads) return;
    const directory = join(this.options.directory, key);
    const ownerPath = join(directory, "terminal.json");
    const retiredPath = join(directory, "retired.json");
    const lifecycle = this.options.lifecycle;
    if (!lifecycle) return; // No authoritative inventory: retain, never guess.
    const currentOwner = lifecycle.owner(key);
    if (currentOwner === undefined) return;
    if (currentOwner !== null) {
      const metadata = await readMetadata(ownerPath, this.fs);
      if (usage.uploads || lifecycle.owner(key) !== currentOwner) return;
      if (metadataOwner(metadata) !== currentOwner)
        await writeMetadata(ownerPath, { terminalId: currentOwner }, this.fs);
      await this.fs.rm(retiredPath, { force: true });
      return;
    }
    const now = (this.options.now ?? Date.now)();
    const retiredAt = await this.retirementTime(key, directory, now);
    if (now - retiredAt < (this.options.retentionMs ?? RETENTION_MS)) return;
    const release = lifecycle.claimInactive(key);
    if (!release) return;
    try {
      // Claim only the final deletion, never metadata reads or a directory scan.
      // A new creation marks the ID pending before waiting on this deletion.
      if (usage.uploads || this.stopped || lifecycle.owner(key) !== null) return;
      await this.fs.rm(directory, { recursive: true, force: true });
      this.bytes -= usage.bytes;
      this.files -= usage.files;
      this.usage.delete(key);
      this.reactivated.delete(key);
    } finally {
      release();
    }
  }
  private async retirementTime(key: string, directory: string, now: number): Promise<number> {
    const owner = metadataOwner(await readMetadata(join(directory, "terminal.json"), this.fs));
    const orphan = owner === undefined || terminalFileKey(owner) !== key;
    const retiredPath = join(directory, "retired.json");
    const metadata = await readMetadata(retiredPath, this.fs);
    const orphanTime =
      typeof metadata === "object" && metadata !== null && "orphanedAt" in metadata
        ? metadata.orphanedAt
        : undefined;
    const resetRetirement = this.reactivated.get(key);
    let timestamp = orphan ? orphanTime : metadata;
    if (resetRetirement !== undefined) timestamp = undefined;
    const retiredAt = typeof timestamp === "number" && Number.isFinite(timestamp) ? timestamp : now;
    if (timestamp !== retiredAt)
      await writeMetadata(retiredPath, orphan ? { orphanedAt: now } : now, this.fs);
    if (resetRetirement !== undefined && this.reactivated.get(key) === resetRetirement)
      this.reactivated.delete(key);
    return retiredAt;
  }
}

async function readMetadata(path: string, files = terminalImageFileSystem): Promise<unknown> {
  let contents: string;
  try {
    contents = await files.readFile(path, "utf8");
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

async function writeMetadata(
  path: string,
  value: unknown,
  files = terminalImageFileSystem,
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await files.writeFile(temporary, JSON.stringify(value), {
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
    await files.rename(temporary, path);
  } finally {
    await files.rm(temporary, { force: true });
  }
}

async function privateDirectory(path: string, files = terminalImageFileSystem): Promise<void> {
  await files.mkdir(path, { recursive: true, mode: 0o700 });
  const info = await files.lstat(path);
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
    await files.chmod(path, 0o700);
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
