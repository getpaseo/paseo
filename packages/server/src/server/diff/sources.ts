import { lstat, readlink } from "node:fs/promises";
import { resolve } from "node:path";
import { readGitFileContents, readGitFileContentAtRef } from "../../utils/git-file-contents.js";
import type { ListedFile } from "./git.js";

interface SourceOptions {
  cwd: string;
  baseSha: string;
  headSha: string | null;
  files: ListedFile[];
}
interface HighlightContext {
  oldFileContent: string | null;
  newFileContent: string | null | undefined;
}

// Keep one bounded page of source text; bodies are still highlighted only when requested.
export class HighlightSources {
  private indices: Map<string, number>;
  private page = -1;
  private pending: Promise<Map<string, string | null> | null> | null = null;
  constructor(private options: SourceOptions) {
    this.indices = new Map(options.files.map((file, index) => [file.entry.path, index]));
  }
  async read(file: ListedFile): Promise<HighlightContext> {
    const index = this.indices.get(file.entry.path);
    if (index === undefined) throw new Error("Unknown comparison file");
    const page = Math.floor(index / 64) * 64;
    if (this.pending === null || this.page !== page) {
      this.page = page;
      this.pending = this.load(page);
    }
    const contents = await this.pending;
    const oldFileContent =
      file.entry.change === "added"
        ? null
        : await this.content(contents, this.options.baseSha, file.entry.oldPath ?? file.entry.path);
    let newFileContent: string | null | undefined;
    if (this.options.headSha !== null) {
      newFileContent = await this.content(contents, this.options.headSha, file.entry.path);
    } else if (file.entry.change !== "deleted") {
      const path = resolve(this.options.cwd, file.entry.path);
      newFileContent = await readWorktreeLink(path);
    }
    return { oldFileContent, newFileContent };
  }
  private async load(start: number): Promise<Map<string, string | null> | null> {
    const specs: string[] = [];
    for (const file of this.options.files.slice(start, start + 64)) {
      if (file.entry.content === "binary") continue;
      if (file.entry.change !== "added")
        specs.push(`${this.options.baseSha}:${file.entry.oldPath ?? file.entry.path}`);
      if (this.options.headSha !== null) specs.push(`${this.options.headSha}:${file.entry.path}`);
    }
    return readGitFileContents(this.options.cwd, specs);
  }
  private async content(
    contents: Map<string, string | null> | null,
    ref: string,
    path: string,
  ): Promise<string | null> {
    if (contents === null) return readGitFileContentAtRef(this.options.cwd, ref, path);
    const content = contents.get(`${ref}:${path}`);
    if (content === undefined) throw new Error("Missing comparison source");
    return content;
  }
}

async function readWorktreeLink(path: string): Promise<string | undefined> {
  try {
    if ((await lstat(path)).isSymbolicLink()) return await readlink(path);
  } catch {
    // Source context is optional; files can disappear after Git reads the patch.
  }
  return undefined;
}
