import { stat } from "node:fs/promises";
import { join } from "node:path";
import { GIT_METADATA_EVENT_RULES } from "../git-metadata-event-rules.js";
import { checkDiffRevisions, type RevisionWatch } from "./revision-probe.js";

const FIRST_DELAY_MS = 5000;
const MAX_DELAY_MS = 60000;
const metadataFiles = [
  ...new Set(
    GIT_METADATA_EVENT_RULES.filter(
      (rule) => rule.match === "exact" && rule.id !== "packed-refs",
    ).map((rule) => rule.path),
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

export function pollDiffMetadata(
  root: string,
  revisions: ReadonlySet<RevisionWatch>,
  changed: (paths: string[]) => void,
  probeFailed: (error: unknown, cwd: string) => void,
) {
  let closed = false;
  let delay = FIRST_DELAY_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void>;
  let previous: string[];

  function schedule() {
    timer = setTimeout(() => {
      pending = sample();
    }, delay);
    timer.unref();
  }

  function readFiles() {
    return Promise.all(metadataFiles.map((path) => fileIdentity(join(root, path))));
  }

  async function sample() {
    const current = await readFiles();
    if (closed) return;
    const paths = metadataFiles.filter((_, index) => current[index] !== previous[index]);
    if (paths.length) changed(paths);
    previous = current;
    const refsChanged = await checkDiffRevisions(root, revisions, probeFailed);
    if (closed) return;
    delay = paths.length || refsChanged ? FIRST_DELAY_MS : Math.min(delay * 2, MAX_DELAY_MS);
    schedule();
  }

  async function initialize() {
    previous = await readFiles();
    if (!closed) schedule();
  }

  // File identities establish the event boundary before the first diff. The
  // comparison's own revision reads establish its ref baseline.
  const ready = (pending = initialize());
  return {
    ready,
    async close() {
      closed = true;
      clearTimeout(timer);
      await pending;
    },
  };
}
