/**
 * How a result row names its file.
 *
 * A flat list of occurrences is full of repeated base names — four `index.tsx` rows tell the
 * reader nothing. The nearest directories are what distinguish them, and they are also what an
 * end-truncated path throws away first. So the row keeps the file name and the closest parents,
 * and marks the elided head with a leading ellipsis.
 */
export interface ResultPathParts {
  /** Directory context immediately above the file, already elided at the head when deeper. */
  directory: string;
  /** Every directory above the file, for the row the reader is pointing at or has selected. */
  head: string;
  /** File name, which is never truncated away. */
  name: string;
}

const PARENTS_KEPT = 1;

export function describeResultPath(path: string): ResultPathParts {
  const segments = path.split("/");
  const name = segments.pop() ?? path;
  if (segments.length === 0) return { directory: "", head: "", name };
  const kept = segments.slice(-PARENTS_KEPT);
  const elided = segments.length > kept.length;
  return {
    directory: `${elided ? "…/" : ""}${kept.join("/")}/`,
    head: `${segments.join("/")}/`,
    name,
  };
}
