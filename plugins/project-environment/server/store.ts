import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { variableInput } from "../shared/environment";

const execFileAsync = promisify(execFile);
const documentSchema = z.object({ variables: z.array(variableInput).max(256) });
export type Variable = z.infer<typeof variableInput>;
export interface ProjectScope {
  id: string;
  cwd: string;
}

export async function projectScope(directory: string): Promise<ProjectScope> {
  const cwd = await realpath(directory);
  let identity = cwd;
  try {
    const result = await execFileAsync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      { cwd, timeout: 5000 },
    );
    identity = await realpath(result.stdout.trim());
  } catch (error) {
    // A non-Git directory gets its own scope. Other failures must not silently change scope.
    const notRepository =
      error instanceof Error &&
      "stderr" in error &&
      String(error.stderr).includes("not a git repository");
    if (!notRepository)
      throw new Error("Cannot resolve project environment scope", { cause: error });
  }
  return { id: createHash("sha256").update(identity).digest("hex"), cwd };
}

export async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

export async function privateWrite(file: string, value: unknown): Promise<void> {
  await privateDirectory(path.dirname(file));
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function readJson(file: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    // Parser errors can include stored secret values. Never attach them to an RPC error.
    // oxlint-disable-next-line preserve-caught-error
    throw new Error("Cannot read project environment storage");
  }
}

export class EnvironmentStore {
  private writes = Promise.resolve();
  constructor(private directory: string) {}

  async read(scope: ProjectScope): Promise<Variable[]> {
    const data = await readJson(path.join(this.directory, `${scope.id}.json`));
    if (data === null) return [];
    const result = documentSchema.safeParse(data);
    if (!result.success) throw new Error("Project environment storage is invalid");
    return result.data.variables;
  }

  async save(scope: ProjectScope, variable: Variable): Promise<void> {
    const parsed = variableInput.safeParse(variable);
    if (!parsed.success) throw new Error("Invalid environment variable");
    return this.change(scope, (variables) => {
      const next = variables.filter((entry) => entry.name !== variable.name);
      if (next.length >= 256) throw new Error("A project can have at most 256 variables");
      return [...next, parsed.data].sort((a, b) => a.name.localeCompare(b.name));
    });
  }

  async remove(scope: ProjectScope, name: string): Promise<void> {
    return this.change(scope, (variables) => variables.filter((entry) => entry.name !== name));
  }

  private change(
    scope: ProjectScope,
    update: (variables: Variable[]) => Variable[],
  ): Promise<void> {
    const write = this.writes.then(async () => {
      const variables = update(await this.read(scope));
      return privateWrite(path.join(this.directory, `${scope.id}.json`), { variables });
    });
    this.writes = write.catch(() => {});
    return write;
  }
}
