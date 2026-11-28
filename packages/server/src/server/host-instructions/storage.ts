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

export class InstructionPersistenceError extends Error {
  constructor(cause: unknown) {
    super("Could not persist host instructions", { cause });
  }
}

/** Serialize snapshots in admission order. After a failed write, restart from disk. */
export class InstructionFileWriter {
  private tail = Promise.resolve();

  constructor(private readonly file: string) {}

  settled(): Promise<void> {
    return this.tail;
  }

  async readSettled<T>(read: () => T): Promise<T> {
    for (;;) {
      const tail = this.tail;
      await tail;
      // A commit can publish a new snapshot while this read is waiting.
      if (tail === this.tail) return read();
    }
  }

  persist(value: unknown): Promise<void> {
    const snapshot = JSON.stringify(value);
    this.tail = this.tail.then(() =>
      writePrivateFileAtomic(this.file, snapshot).catch((error: unknown) => {
        throw new InstructionPersistenceError(error);
      }),
    );
    return this.tail;
  }
}
