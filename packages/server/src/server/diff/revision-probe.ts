import { resolveCheckoutDiffBase } from "../../utils/checkout-git.js";
import { createRunGitCommand } from "../../utils/run-git-command.js";
import type { Compare, ComparisonRevisions } from "./git.js";

const git = createRunGitCommand("diff-metadata-poll", { priority: "background" });
const TIMEOUT_MS = 5000;
const BATCH_SIZE = 128;

export interface RevisionWatch {
  cwd: string;
  checkoutBase?: Compare["checkoutBase"];
  getRevisions(): ComparisonRevisions | null;
  changed(): void;
}

function probeDirectory(commonCwd: string, cwd: string, ref: string): string {
  // HEAD, shorthand and revision expressions can resolve differently in linked
  // worktrees. Only qualified refs in the shared namespaces use the common root.
  return /^refs\/(?:heads|remotes|tags)\/[\w./-]+$/.test(ref) ? commonCwd : cwd;
}

function recordBatch(
  result: Map<string, string | null>,
  refs: string[],
  queries: string[],
  stdout: string,
) {
  let offset = 0;
  for (const [position, query] of queries.entries()) {
    const unresolved = [`${query} missing\n`, `${query} ambiguous\n`].find((record) =>
      stdout.startsWith(record, offset),
    );
    if (unresolved) {
      result.set(refs[position], null);
      offset += unresolved.length;
      continue;
    }
    const end = stdout.indexOf("\n", offset);
    const sha = stdout.slice(offset, end);
    if (end === -1 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)) return;
    result.set(refs[position], sha);
    offset = end + 1;
  }
}

async function readRevisions(cwd: string, refs: Set<string>): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  const names = [...refs];
  for (let index = 0; index < names.length; index += BATCH_SIZE) {
    const batch = names.slice(index, index + BATCH_SIZE);
    try {
      // -z works with older Git versions. Missing records include the query
      // verbatim, so they cannot be split on line breaks.
      const queries = batch.map((ref) => `${ref}^{commit}`);
      const output = await git(["cat-file", "-z", "--batch-check=%(objectname)"], {
        cwd,
        input: queries.join("\0") + "\0",
        timeout: TIMEOUT_MS,
      });
      if (!output.truncated) recordBatch(result, batch, queries, output.stdout);
    } catch {
      // Keep the comparison's baseline when the probe itself fails.
    }
  }
  return result;
}

export async function checkDiffRevisions(watches: ReadonlySet<RevisionWatch>): Promise<boolean> {
  const active = [...watches].flatMap((watch) => {
    const previous = watch.getRevisions();
    return previous ? [{ watch, previous }] : [];
  });
  const commonCwd = active[0]?.watch.cwd;
  if (commonCwd === undefined) return false;
  const requests = new Map<string, Set<string>>();
  for (const { watch, previous } of active) {
    for (const ref of previous.refs.keys()) {
      const cwd = probeDirectory(commonCwd, watch.cwd, ref);
      const refs = requests.get(cwd) ?? new Set<string>();
      refs.add(ref);
      requests.set(cwd, refs);
    }
  }
  const reads = new Map([...requests].map(([cwd, refs]) => [cwd, readRevisions(cwd, refs)]));
  const checkoutBases = new Map<string, Promise<string | null | undefined>>();
  async function readCheckoutBase(watch: RevisionWatch, observed: string | null) {
    const base = watch.checkoutBase;
    if (!base) return observed;
    // An explicit qualified selection is already checked by the revision batch.
    if (observed === base.compare.baseRef && /^refs\/(?:heads|remotes)\//.test(observed)) {
      return observed;
    }
    const key = JSON.stringify([watch.cwd, base]);
    let selected = checkoutBases.get(key);
    if (!selected) {
      selected = resolveCheckoutDiffBase(watch.cwd, base.compare, {
        paseoHome: base.paseoHome,
        runGitCommand: (args, options) => git(args, { ...options, timeout: TIMEOUT_MS }),
      }).catch(() => undefined);
      checkoutBases.set(key, selected);
    }
    return selected;
  }

  const changed = await Promise.all(
    active.map(async ({ watch, previous }) => {
      const base = previous.checkoutBase;
      const [selected, refs] = await Promise.all([
        base === undefined ? undefined : readCheckoutBase(watch, base),
        Promise.all(
          [...previous.refs].map(async ([ref, sha]) => {
            const current = (await reads.get(probeDirectory(commonCwd, watch.cwd, ref)))?.get(ref);
            return current !== undefined && current !== sha && previous.refs.get(ref) === sha;
          }),
        ),
      ]);
      if (
        ((selected !== undefined && selected !== base && previous.checkoutBase === base) ||
          refs.some(Boolean)) &&
        watches.has(watch) &&
        watch.getRevisions() === previous
      ) {
        watch.changed();
        return true;
      }
      return false;
    }),
  );
  return changed.some(Boolean);
}
