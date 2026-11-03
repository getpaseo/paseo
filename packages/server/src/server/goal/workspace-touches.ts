import type { Task } from "@getpaseo/protocol/goal/types";

/** The whole checkout: what a task that declares no paths, or a path outside it, claims. */
const EVERYTHING = "";

/**
 * A declared path as a directory prefix ("" = everything, "src/a/" = that directory) or an exact
 * file ("src/a.ts"). A glob tail ("**", "*") means the directory above it. Absolute paths and
 * ".." leave the checkout, so they are not trusted and claim everything.
 */
function normalize(raw: string): string {
  let value = raw.trim().replaceAll("\\", "/");
  value = value.replace(/^\.\//, "");
  if (value === "." || value === "./" || value === "") return EVERYTHING;
  if (value.startsWith("/") || value.split("/").includes("..")) return EVERYTHING;
  const star = value.search(/[*?[]/);
  if (star !== -1) {
    const slash = value.lastIndexOf("/", star);
    return slash === -1 ? EVERYTHING : value.slice(0, slash + 1);
  }
  return value;
}

/** A path with its trailing slash dropped, so "src/a" and "src/a/" name the same directory. */
function asDirectory(path: string): string {
  return path === EVERYTHING || path.endsWith("/") ? path : `${path}/`;
}

/** One contains the other, as a file, or as a directory whether or not it ends in a slash. */
function overlaps(a: string, b: string): boolean {
  if (a === b) return true;
  return b.startsWith(asDirectory(a)) || a.startsWith(asDirectory(b));
}

/** What the task claims. A task that declares nothing claims the whole checkout. */
export function claimOf(task: Pick<Task, "touches">): string[] {
  const declared = task.touches?.map(normalize) ?? [];
  return declared.length === 0 ? [EVERYTHING] : declared;
}

/** Whether two tasks may change the same file, by what they declared. */
export function tasksOverlap(a: Pick<Task, "touches">, b: Pick<Task, "touches">): boolean {
  const right = claimOf(b);
  return claimOf(a).some((x) => right.some((y) => overlaps(x, y)));
}

/** Whether a changed file lies within what the task declared; a task with none owns all files. */
export function isWithinClaim(task: Pick<Task, "touches">, filePath: string): boolean {
  const file = filePath.replaceAll("\\", "/");
  return claimOf(task).some((claim) => overlaps(claim, file));
}
