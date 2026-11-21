import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { link, lstat, open, realpath, unlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { output } from "zod";
import type { inspectDestination, target } from "../shared/contracts";

type Target = output<typeof target>;
interface Project {
  projectId: string;
  projectRootPath: string;
  projectKind: string;
}
const exec = promisify(execFile);

function errorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

async function destination(projects: Project[], input: Target) {
  const project = projects.find(({ projectId }) => projectId === input.projectId);
  if (project?.projectKind !== "git" || project.projectRootPath !== input.root) {
    throw new Error("The destination project changed. Select it again.");
  }
  const root = await realpath(project.projectRootPath);
  return { root, path: join(root, input.name) };
}

async function status(
  root: string,
  path: string,
  name: string,
): Promise<output<typeof inspectDestination.output>["status"]> {
  try {
    await lstat(path);
    return "exists";
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  try {
    await exec("git", ["check-ignore", "--quiet", "--", name], { cwd: root, timeout: 4000 });
    return "ready";
  } catch (error) {
    if (errorCode(error) === 1) return "not-ignored";
    throw new Error("Paseo could not check whether Git ignores this path.", { cause: error });
  }
}

export async function inspect(projects: Project[], input: Target) {
  const { root, path } = await destination(projects, input);
  return { path, status: await status(root, path, input.name) };
}

export async function install(
  projects: Project[],
  input: Target & { path: string },
  bytes: Uint8Array,
) {
  const { root, path } = await destination(projects, input);
  if (path !== input.path) throw new Error("The destination changed. Select the file again.");
  if ((await status(root, path, input.name)) !== "ready") {
    throw new Error("The destination now exists or Git does not ignore it. No file was imported.");
  }
  // Put the staging file under git's private directory, where a concurrent git add cannot see it.
  const { stdout } = await exec("git", ["rev-parse", "--absolute-git-dir"], {
    cwd: root,
    timeout: 4000,
  });
  const stage = join(stdout.trimEnd(), `paseo-local-file-${randomUUID()}`);
  const file = await open(stage, "wx", 0o600);
  try {
    try {
      await file.writeFile(bytes);
    } finally {
      await file.close();
    }
    if (
      (await realpath(input.root)) !== root ||
      (await status(root, path, input.name)) !== "ready"
    ) {
      throw new Error("The destination changed. No file was imported.");
    }
    // link publishes the complete file and fails if a file or symlink appeared after the check.
    await link(stage, path);
  } finally {
    await unlink(stage);
  }
  return { path };
}
