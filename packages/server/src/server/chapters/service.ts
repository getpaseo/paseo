import { z } from "zod";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  ChapterStorySchema,
  type ChapterComparison,
  type ChapterOutline,
  type ChapterState,
  type ChapterStory,
  type ParsedDiffFile,
} from "@getpaseo/protocol/messages";
import { ChapterValidationError, validateChapterOutline } from "@getpaseo/protocol/chapters";

interface Snapshot {
  files: ParsedDiffFile[];
  tooLarge: boolean;
}
interface Entry {
  story: ChapterStory | null;
  pending: boolean;
  attempted: string | null;
  error: string | null;
}
export interface ChaptersServiceOptions {
  directory: string;
  read: (cwd: string, comparison: ChapterComparison) => Promise<Snapshot>;
  generate: (cwd: string, snapshotPath: string, files: ParsedDiffFile[]) => Promise<ChapterOutline>;
}

export function chapterFingerprint(comparison: ChapterComparison, files: ParsedDiffFile[]): string {
  // Highlight tokens are presentation; theme changes must not invalidate a story.
  const source = JSON.stringify({ version: 1, comparison, files }, (key, value: unknown) => {
    if (key === "tokens") return undefined;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(
        Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
      );
    }
    return value;
  });
  return createHash("sha256").update(source).digest("hex");
}

export class ChaptersService {
  private readonly entries = new Map<string, Entry>();
  private readonly opening = new Map<string, Promise<Entry>>();
  constructor(private readonly options: ChaptersServiceOptions) {}

  async get(input: {
    cwd: string;
    comparison: ChapterComparison;
    generate: boolean;
    regenerate: boolean;
  }): Promise<ChapterState> {
    const cwd = resolve(input.cwd);
    const comparison: ChapterComparison = {
      mode: input.comparison.mode,
      ignoreWhitespace: input.comparison.ignoreWhitespace === true,
    };
    if (comparison.mode === "base" && input.comparison.baseRef)
      comparison.baseRef = input.comparison.baseRef;
    const key = createHash("sha256").update(JSON.stringify({ cwd, comparison })).digest("hex");
    const snapshot = await this.options.read(cwd, comparison);
    const fingerprint = chapterFingerprint(comparison, snapshot.files);
    const entry = await this.open(key);
    if (snapshot.tooLarge || snapshot.files.some((file) => file.status === "too_large")) {
      return {
        status: "unsupported",
        currentFingerprint: fingerprint,
        story: entry.story,
        error: "This diff exceeds the supported size. Chapters require the complete diff.",
      };
    }
    if (!snapshot.files.length)
      return { status: "empty", currentFingerprint: fingerprint, story: entry.story, error: null };
    const first = input.generate && !entry.story && entry.attempted === null;
    if (!entry.pending && (first || input.regenerate)) {
      entry.pending = true;
      entry.attempted = fingerprint;
      entry.error = null;
      void this.run({
        key,
        cwd,
        comparison,
        fingerprint,
        files: structuredClone(snapshot.files),
        entry,
      });
    }
    let status: ChapterState["status"] = "empty";
    if (entry.story) status = "ready";
    if (entry.error) status = "error";
    if (entry.pending) status = "generating";
    return { status, currentFingerprint: fingerprint, story: entry.story, error: entry.error };
  }

  private async open(key: string): Promise<Entry> {
    const existing = this.entries.get(key);
    if (existing) return existing;
    const pending = this.opening.get(key);
    if (pending) return pending;
    const opening = this.load(key);
    this.opening.set(key, opening);
    try {
      return await opening;
    } finally {
      this.opening.delete(key);
    }
  }

  private async load(key: string): Promise<Entry> {
    const story = await this.readCached(key);
    const entry: Entry = { story, pending: false, attempted: null, error: null };
    this.entries.set(key, entry);
    return entry;
  }

  private async readCached(key: string): Promise<ChapterStory | null> {
    try {
      const story = ChapterStorySchema.parse(
        JSON.parse(await readFile(join(this.options.directory, `${key}.json`), "utf8")),
      );
      validateChapterOutline(story.outline, story.files);
      return story.fingerprint === chapterFingerprint(story.comparison, story.files) ? story : null;
    } catch (error) {
      const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
      const invalid =
        error instanceof z.ZodError ||
        error instanceof SyntaxError ||
        error instanceof ChapterValidationError;
      if (missing || invalid) return null;
      throw error;
    }
  }

  private async publish(key: string, story: ChapterStory): Promise<void> {
    const destination = join(this.options.directory, `${key}.json`);
    await writeFile(`${destination}.tmp`, JSON.stringify(story), "utf8");
    await rename(`${destination}.tmp`, destination);
  }

  private async run(input: {
    key: string;
    cwd: string;
    comparison: ChapterComparison;
    fingerprint: string;
    files: ParsedDiffFile[];
    entry: Entry;
  }): Promise<void> {
    const { key, cwd, comparison, fingerprint, files, entry } = input;
    try {
      await mkdir(this.options.directory, { recursive: true });
      const cached = await this.readCached(`${key}-${fingerprint}`);
      if (cached) {
        await this.publish(key, cached);
        entry.story = cached;
        return;
      }
      const snapshotPath = join(this.options.directory, `${key}-${fingerprint}.patch.json`);
      await writeFile(
        snapshotPath,
        JSON.stringify(
          indexedSnapshot(files),
          (field, value) => (field === "tokens" ? undefined : value),
          2,
        ),
        "utf8",
      );
      let outline: ChapterOutline;
      try {
        outline = await this.options.generate(cwd, snapshotPath, files);
      } finally {
        await unlink(snapshotPath);
      }
      validateChapterOutline(outline, files);
      const story: ChapterStory = {
        fingerprint,
        comparison,
        files,
        outline,
        createdAt: new Date().toISOString(),
      };
      await this.publish(`${key}-${fingerprint}`, story);
      await this.publish(key, story);
      entry.story = story;
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
    } finally {
      entry.pending = false;
    }
  }
}

// Explicit indices let read-only helpers address large files without counting JSON lines.
function indexedSnapshot(files: ParsedDiffFile[]) {
  return files.map((file, fileIndex) => ({
    ...file,
    fileIndex,
    hunks: file.hunks.map((hunk, hunkIndex) => ({
      ...hunk,
      hunkIndex,
      lines: hunk.lines.map((line, lineIndex) => ({ ...line, lineIndex })),
    })),
  }));
}
