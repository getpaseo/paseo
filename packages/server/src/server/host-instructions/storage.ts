import { readFile } from "node:fs/promises";
import { writePrivateFileAtomic } from "../private-files.js";

export async function readInstructionFile<T>(
  file: string,
  parse: (value: unknown) => T,
  initial: T,
): Promise<T> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return initial;
    throw error;
  }
  return parse(JSON.parse(raw));
}

/** Serialize snapshots in admission order. After a failed write, restart from disk. */
export class InstructionFileWriter {
  private tail = Promise.resolve();

  constructor(private readonly file: string) {}

  settled(): Promise<void> {
    return this.tail;
  }

  persist(value: unknown): Promise<void> {
    const snapshot = JSON.stringify(value);
    this.tail = this.tail.then(() => writePrivateFileAtomic(this.file, snapshot));
    return this.tail;
  }
}
