import { runGitCommand, type GitCommandOptions } from "../../utils/run-git-command.js";
import { parseDiff } from "../utils/diff-highlighter.js";
import type { ListedFile } from "./git.js";

interface Patch {
  stdout: string;
  truncated: boolean;
}

// Acquire one bounded page lazily. Highlighting and delivery remain per file.
export class Patches {
  private files: ListedFile[];
  private pending = new Map<string, Promise<Map<string, Patch>>>();
  constructor(
    private args: string[],
    private options: GitCommandOptions,
    files: ListedFile[],
  ) {
    this.files = files.filter((file) => file.source.kind === "tracked" && file.entry.body);
  }
  select(paths: ReadonlySet<string>): void {
    this.files = this.files.filter((file) => paths.has(file.entry.path));
  }
  async read(file: ListedFile, maxBytes: number): Promise<Patch> {
    const existing = this.pending.get(file.entry.path);
    if (existing) return (await existing).get(file.entry.path) ?? { stdout: "", truncated: false };
    const renamed = file.entry.oldPath !== null;
    const candidates = this.files.filter(
      (candidate) => (candidate.entry.oldPath !== null) === renamed,
    );
    const index = candidates.indexOf(file);
    const page = renamed || index < 0 ? [file] : candidates.slice(index, index + 64);
    this.pending.clear();
    const reading = this.load(page, maxBytes);
    for (const candidate of page) this.pending.set(candidate.entry.path, reading);
    return (await reading).get(file.entry.path) ?? { stdout: "", truncated: false };
  }

  private async load(files: ListedFile[], maxBytes: number): Promise<Map<string, Patch>> {
    const paths = [
      ...new Set(
        files.flatMap((file) =>
          file.entry.oldPath === null ? [file.entry.path] : [file.entry.oldPath, file.entry.path],
        ),
      ),
    ];
    const result = await runGitCommand(
      [
        ...this.args,
        ...(files[0].entry.oldPath !== null ? ["--diff-filter=RC"] : []),
        "--patch",
        "--",
        ...paths.map((path) => `:(literal)${path}`),
      ],
      {
        ...this.options,
        acceptExitCodes: [0, 1],
        maxOutputBytes: (files.length === 1 ? maxBytes : 8 * maxBytes) + 1,
      },
    );
    if (files.length === 1) return new Map([[files[0].entry.path, result]]);
    if (result.truncated) {
      const middle = Math.ceil(files.length / 2);
      return new Map([
        ...(await this.load(files.slice(0, middle), maxBytes)),
        ...(await this.load(files.slice(middle), maxBytes)),
      ]);
    }
    const patches = new Map<string, Patch>();
    for (const section of result.stdout.split(/(?=^diff --git )/m).filter(Boolean)) {
      const hunkStart = section.indexOf("\n@@ ");
      const parsed = parseDiff(hunkStart < 0 ? section : section.slice(0, hunkStart))[0];
      if (!parsed) throw new Error("Git returned an invalid patch header");
      const previous = patches.get(parsed.path)?.stdout ?? "";
      const stdout = previous + section;
      patches.set(parsed.path, { stdout, truncated: Buffer.byteLength(stdout) > maxBytes });
    }
    return patches;
  }
}
