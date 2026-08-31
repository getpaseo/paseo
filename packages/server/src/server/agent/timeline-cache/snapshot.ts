import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { writeFileAtomic } from "../../atomic-file.js";
import { validateCatalogRef } from "./cache-validation.js";
import { withTimelineMutationLock } from "./file-mutation-lock.js";
import type { TimelineMutationLockOptions } from "./file-mutation-lock.js";
import type { CatalogPageRef } from "./paged-catalog.js";
import { PagedTimelineCatalog } from "./paged-catalog.js";
import { readJsonFileCapped } from "./safe-json-file.js";

export interface TimelineManifest {
  version: 1;
  generation: number;
  epoch: string;
  nextSeq: number;
  minSeq: number;
  maxSeq: number;
  root: CatalogPageRef | null;
}

export type TimelineManifestFields = Omit<TimelineManifest, "version" | "generation">;

export interface TimelineSnapshotLease {
  manifest: TimelineManifest;
  release(): void;
}

export interface TimelineSnapshotManagerOptions {
  maxManifestBytes?: number;
  afterManifestRead?: (manifest: TimelineManifest) => Promise<void>;
  writeFileAtomic?: (filePath: string, data: string) => Promise<void>;
  mutationLock?: TimelineMutationLockOptions;
}

interface ActiveGeneration {
  count: number;
  root: CatalogPageRef | null;
}

const activeGenerations = new Map<string, Map<number, ActiveGeneration>>();
const DEFAULT_MAX_MANIFEST_BYTES = 64 * 1024;

export class TimelineSnapshotManager {
  private readonly maxManifestBytes: number;
  private readonly afterManifestRead?: (manifest: TimelineManifest) => Promise<void>;
  private readonly writeAtomic: (filePath: string, data: string) => Promise<void>;
  private readonly mutationLock?: TimelineMutationLockOptions;
  private readonly emptyEpoch = randomUUID();

  constructor(
    private readonly directory: string,
    private readonly catalog: PagedTimelineCatalog,
    options?: TimelineSnapshotManagerOptions,
  ) {
    this.maxManifestBytes = options?.maxManifestBytes ?? DEFAULT_MAX_MANIFEST_BYTES;
    this.afterManifestRead = options?.afterManifestRead;
    this.writeAtomic = options?.writeFileAtomic ?? writeFileAtomic;
    this.mutationLock = options?.mutationLock;
    if (!Number.isSafeInteger(this.maxManifestBytes) || this.maxManifestBytes < 1) {
      throw new Error("maxManifestBytes must be a positive safe integer");
    }
  }

  async load(): Promise<TimelineSnapshotLease> {
    for (;;) {
      const first = await this.readManifest();
      const release = this.acquire(first);
      const second = await this.readManifest();
      if (sameSnapshotIdentity(first, second)) {
        return { manifest: first, release };
      }
      release();
    }
  }

  async publish(
    expected: TimelineManifest,
    build: () => Promise<TimelineManifestFields>,
  ): Promise<TimelineManifest> {
    await fs.mkdir(this.directory, { recursive: true });
    return await withTimelineMutationLock(
      this.directory,
      async () => {
        const current = await this.readManifest();
        if (!sameSnapshotIdentity(current, expected)) {
          throw new Error(
            `Timeline snapshot changed from generation ${expected.generation} to ${current.generation}`,
          );
        }
        const fields = await build();
        const manifest = validateManifest({
          version: 1,
          generation: expected.generation + 1,
          ...fields,
        });
        const text = JSON.stringify(manifest);
        if (Buffer.byteLength(text) > this.maxManifestBytes) {
          throw new Error(`Timeline manifest exceeds the ${this.maxManifestBytes}-byte limit`);
        }
        await this.writeAtomic(this.manifestPath(), text);
        return manifest;
      },
      this.mutationLock,
    );
  }

  async collectGarbage(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
    await withTimelineMutationLock(
      this.directory,
      async () => {
        const current = await this.load();
        try {
          const roots = new Map<string, CatalogPageRef>();
          if (current.manifest.root) roots.set(current.manifest.root.file, current.manifest.root);
          for (const active of activeGenerations.get(this.directory)?.values() ?? []) {
            if (active.root) roots.set(active.root.file, active.root);
          }
          const pageFiles = new Set<string>();
          const segmentFiles = new Set<string>();
          for (const root of roots.values()) {
            const reachable = await this.catalog.collectReachable(root);
            for (const file of reachable.pageFiles) pageFiles.add(file);
            for (const segment of reachable.segments) segmentFiles.add(segment.file);
          }
          const files = await fs.readdir(this.directory).catch(() => [] as string[]);
          await Promise.all(
            files
              .filter(
                (file) =>
                  (file.startsWith("catalog-") && !pageFiles.has(file)) ||
                  (file.startsWith("segment-") && !segmentFiles.has(file)),
              )
              .map(async (file) => await fs.rm(path.join(this.directory, file), { force: true })),
          );
        } finally {
          current.release();
        }
      },
      this.mutationLock,
    );
  }

  async deleteCache(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
    await withTimelineMutationLock(
      this.directory,
      async () => await fs.rm(this.directory, { recursive: true, force: true }),
      this.mutationLock,
    );
  }

  private async readManifest(): Promise<TimelineManifest> {
    let manifest: TimelineManifest;
    try {
      manifest = validateManifest(
        await readJsonFileCapped(this.manifestPath(), this.maxManifestBytes),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        manifest = {
          version: 1,
          generation: 0,
          epoch: this.emptyEpoch,
          nextSeq: 1,
          minSeq: 0,
          maxSeq: 0,
          root: null,
        };
      } else throw error;
    }
    await this.afterManifestRead?.(manifest);
    return manifest;
  }

  private acquire(manifest: TimelineManifest): () => void {
    let generations = activeGenerations.get(this.directory);
    if (!generations) {
      generations = new Map();
      activeGenerations.set(this.directory, generations);
    }
    const active = generations.get(manifest.generation);
    if (active && active.root?.file !== manifest.root?.file) {
      throw new Error("Timeline generation points to conflicting catalog roots");
    }
    generations.set(manifest.generation, {
      count: (active?.count ?? 0) + 1,
      root: manifest.root,
    });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = generations!.get(manifest.generation);
      if (!current || current.count === 1) generations!.delete(manifest.generation);
      else generations!.set(manifest.generation, { ...current, count: current.count - 1 });
      if (generations!.size === 0) activeGenerations.delete(this.directory);
    };
  }

  private manifestPath(): string {
    return path.join(this.directory, "manifest.json");
  }
}

function validateManifest(value: unknown): TimelineManifest {
  if (!value || typeof value !== "object") throw new Error("Invalid timeline manifest");
  const manifest = value as Partial<TimelineManifest>;
  if (
    manifest.version !== 1 ||
    !isNonnegativeSafeInteger(manifest.generation) ||
    typeof manifest.epoch !== "string" ||
    !isNonnegativeSafeInteger(manifest.nextSeq) ||
    !isNonnegativeSafeInteger(manifest.minSeq) ||
    !isNonnegativeSafeInteger(manifest.maxSeq) ||
    !(manifest.root === null || typeof manifest.root === "object")
  ) {
    throw new Error("Invalid timeline manifest");
  }
  if (manifest.root) validateCatalogRef(manifest.root);
  if (
    (manifest.root === null &&
      (manifest.minSeq !== 0 || manifest.maxSeq !== 0 || manifest.nextSeq !== 1)) ||
    (manifest.root !== null &&
      (manifest.root.minSeq !== manifest.minSeq ||
        manifest.root.maxSeq !== manifest.maxSeq ||
        manifest.nextSeq! <= manifest.maxSeq!))
  ) {
    throw new Error("Timeline manifest does not match its catalog root");
  }
  return manifest as TimelineManifest;
}

function sameSnapshotIdentity(left: TimelineManifest, right: TimelineManifest): boolean {
  return (
    left.generation === right.generation &&
    left.epoch === right.epoch &&
    left.root?.file === right.root?.file
  );
}

function isNonnegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}
