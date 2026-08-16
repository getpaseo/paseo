import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export function createRuntimeStateStore<T extends { workspaceId: string }>(
  paseoHome: string,
  runtimeId: string,
  validate: (value: unknown, workspaceId: string) => value is T,
) {
  const directory = path.join(paseoHome, "workspace-runtimes", runtimeId);
  const fileFor = (workspaceId: string) =>
    path.join(directory, `${createHash("sha256").update(workspaceId).digest("hex")}.json`);
  return {
    async read(workspaceId: string): Promise<T | null> {
      try {
        const parsed = JSON.parse(await readFile(fileFor(workspaceId), "utf8")) as unknown;
        if (!validate(parsed, workspaceId)) return null;
        return parsed;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async write(state: T): Promise<void> {
      await mkdir(directory, { recursive: true });
      const target = fileFor(state.workspaceId);
      const temporary = `${target}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 });
      await rename(temporary, target);
    },
    async remove(workspaceId: string): Promise<void> {
      await rm(fileFor(workspaceId), { force: true });
    },
  };
}
