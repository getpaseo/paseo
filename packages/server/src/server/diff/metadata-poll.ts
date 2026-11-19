import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { createRunGitCommand } from "../../utils/run-git-command.js";
import { GIT_METADATA_EVENT_RULES } from "../git-metadata-event-rules.js";

const FIRST_DELAY_MS = 5000;
const MAX_DELAY_MS = 60000;
const readRefs = createRunGitCommand("diff-metadata-poll", { priority: "background" });
const metadataFiles = [
  ...new Set(
    GIT_METADATA_EVENT_RULES.filter((rule) => rule.match === "exact").map((rule) => rule.path),
  ),
];

async function fileIdentity(path: string): Promise<string> {
  try {
    const info = await stat(path, { bigint: true });
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code ?? "unavailable";
  }
}

async function refsIdentity(root: string): Promise<string> {
  try {
    const refs = await readRefs(
      ["--git-dir=.", "for-each-ref", "--format=%(refname) %(objectname) %(symref)"],
      { cwd: root, timeout: 5000 },
    );
    if (refs.truncated) return "truncated";
    return createHash("sha256").update(refs.stdout).digest("hex");
  } catch {
    return "unavailable";
  }
}

// Git resolves loose, packed and reftable refs in one read independent of the
// number of comparisons. Report the ref snapshot as a change in the ref namespace.
export function pollDiffMetadata(
  root: string,
  common: boolean,
  changed: (paths: string[]) => void,
) {
  let closed = false;
  let delay = FIRST_DELAY_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void>;
  const inputs: { path: string; read: () => Promise<string> }[] = metadataFiles.map((path) => ({
    path,
    read: () => fileIdentity(join(root, path)),
  }));
  if (common) inputs.push({ path: "refs/heads", read: () => refsIdentity(root) });
  let previous: string[] | undefined;

  async function sample() {
    const current = await Promise.all(inputs.map((input) => input.read()));
    if (closed) return;
    if (previous) {
      const baseline = previous;
      const paths = inputs
        .filter((_, index) => current[index] !== baseline[index])
        .map((input) => input.path);
      delay = paths.length ? FIRST_DELAY_MS : Math.min(delay * 2, MAX_DELAY_MS);
      if (paths.length) changed(paths);
    }
    previous = current;
    timer = setTimeout(() => {
      pending = sample();
    }, delay);
    timer.unref();
  }

  const ready = (pending = sample());
  return {
    ready,
    async close() {
      closed = true;
      clearTimeout(timer);
      await pending;
    },
  };
}
