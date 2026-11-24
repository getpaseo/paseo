import { resolveCheckoutDiffBase } from "../../utils/checkout-git.js";
import { createRunGitCommand } from "../../utils/run-git-command.js";
import type { Compare, ComparisonRevisions } from "./git.js";

const git = createRunGitCommand("diff-metadata-poll", { priority: "background" });
const TIMEOUT_MS = 5000;
const BATCH_SIZE = 128;

export interface RevisionWatch {
  cwd: string;
  gitDirectory: string;
  checkoutBase?: Compare["checkoutBase"];
  getRevisions(): ComparisonRevisions | null;
  changed(): void;
}

function probeDirectory(root: string, watch: RevisionWatch, ref: string): string {
  const sharedRef = /^refs\/(?:heads|remotes|tags)\/[\w./-]+$/.test(ref);
  const mainHead = ref === "HEAD" && watch.gitDirectory === root;
  return sharedRef || mainHead ? root : watch.cwd;
}

async function readRevisions(
  cwd: string,
  commonRoot: string,
  refs: Set<string>,
  failed: (error: unknown, cwd: string) => void,
): Promise<Map<string, string | null>> {
  const result = new Map<string, string | null>();
  const options = {
    cwd,
    timeout: TIMEOUT_MS,
    envOverlay: cwd === commonRoot ? { GIT_DIR: "." } : undefined,
  };
  const names: string[] = [];
  for (const ref of refs) {
    if (/^[\w./-]+$/.test(ref)) {
      names.push(ref);
      continue;
    }
    // Git can abort a whole batch when one revision expression fails to resolve.
    try {
      const output = await git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], {
        ...options,
        acceptExitCodes: [0, 128],
      });
      result.set(ref, output.exitCode === 0 ? output.stdout.trim() : null);
    } catch (error) {
      failed(error, cwd);
    }
  }
  for (let index = 0; index < names.length; index += BATCH_SIZE) {
    const batch = names.slice(index, index + BATCH_SIZE);
    const queries = batch.map((ref) => `${ref}^{commit}`);
    try {
      const output = await git(["cat-file", "--batch-check=%(objectname)"], {
        ...options,
        input: queries.join("\n") + "\n",
      });
      const records = output.stdout.split("\n");
      if (output.truncated || records.length !== queries.length + 1) {
        throw new Error("Git returned incomplete diff revision records");
      }
      for (const [position, query] of queries.entries()) {
        const record = records[position];
        if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(record)) {
          result.set(batch[position], record);
        } else if (record === `${query} missing` || record === `${query} ambiguous`) {
          result.set(batch[position], null);
        }
      }
    } catch (error) {
      failed(error, cwd);
    }
  }
  return result;
}

export async function checkDiffRevisions(
  root: string,
  watches: ReadonlySet<RevisionWatch>,
  failed: (error: unknown, cwd: string) => void,
): Promise<boolean> {
  const active = [...watches].flatMap((watch) => {
    const previous = watch.getRevisions();
    return previous ? [{ watch, previous }] : [];
  });
  const requests = new Map<string, Set<string>>();
  for (const { watch, previous } of active) {
    for (const ref of previous.refs.keys()) {
      const cwd = probeDirectory(root, watch, ref);
      const refs = requests.get(cwd) ?? new Set<string>();
      refs.add(ref);
      requests.set(cwd, refs);
    }
  }
  const reads = new Map(
    [...requests].map(([cwd, refs]) => [cwd, readRevisions(cwd, root, refs, failed)]),
  );
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
            const current = (await reads.get(probeDirectory(root, watch, ref)))?.get(ref);
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
