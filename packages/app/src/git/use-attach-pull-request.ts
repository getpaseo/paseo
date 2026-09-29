import { ForgeSearchItemSchema } from "@getpaseo/protocol/messages";
import type { ForgeSearchClient } from "@/git/use-forge-search-query";
import { searchItemToRelatedPullRequest } from "@/git/pull-request-curation";
import { pullRequestCurationStore } from "@/git/pull-request-curation-store";
import type { RelatedPullRequest } from "@/git/related-pull-requests";

/**
 * Resolves a pull request number the user typed into set facts, through the
 * existing forge search RPC — no new daemon call needed. Only an exact
 * number match on a change request counts; fuzzy search hits never attach.
 * Looks in open pull requests first, then merged ones: `gh pr list` is
 * open-only, so without the second query every merged change request is
 * invisible to attach and scan.
 */
export async function resolvePullRequestForAttach(input: {
  client: ForgeSearchClient;
  cwd: string;
  number: number;
}): Promise<RelatedPullRequest> {
  const open = await searchExactPullRequest({
    client: input.client,
    cwd: input.cwd,
    query: String(input.number),
    number: input.number,
  });
  if (open) {
    return open;
  }
  const merged = await searchExactPullRequest({
    client: input.client,
    cwd: input.cwd,
    query: `${input.number} is:merged`,
    number: input.number,
  });
  if (merged) {
    return merged;
  }
  throw new AttachPullRequestNotFoundError(input.number);
}

async function searchExactPullRequest(input: {
  client: ForgeSearchClient;
  cwd: string;
  query: string;
  number: number;
}): Promise<RelatedPullRequest | null> {
  const payload = await input.client.searchForge({
    cwd: input.cwd,
    query: input.query,
    limit: 10,
    kinds: ["change_request"],
  });
  for (const item of payload.items) {
    const parsed = ForgeSearchItemSchema.safeParse(item);
    if (!parsed.success) {
      continue;
    }
    const candidate = parsed.data;
    if (candidate.kind !== "change_request" || candidate.number !== input.number) {
      continue;
    }
    const related = searchItemToRelatedPullRequest(candidate);
    if (related) {
      return related;
    }
  }
  return null;
}

export class AttachPullRequestNotFoundError extends Error {
  readonly number: number;

  constructor(number: number) {
    super(`No pull request #${number} found`);
    this.name = "AttachPullRequestNotFoundError";
    this.number = number;
  }
}

/**
 * Pull request numbers the way people have them to hand: one number, a
 * comma-separated list, or a column pasted out of a table. A single bad token
 * invalidates the whole input rather than being dropped, so a typo in a list of
 * eight is reported instead of silently costing one pull request.
 */
export function parseAttachPullRequestNumbers(raw: string): number[] | null {
  const tokens = raw.split(/[\s,;]+/).filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return null;
  }
  const numbers: number[] = [];
  for (const token of tokens) {
    const number = parseSinglePullRequestNumber(token);
    if (number === null) {
      return null;
    }
    if (!numbers.includes(number)) {
      numbers.push(number);
    }
  }
  return numbers;
}

function parseSinglePullRequestNumber(token: string): number | null {
  const match = token.match(/^#?(\d{1,7})$/);
  if (!match) {
    return null;
  }
  const number = Number.parseInt(match[1] ?? "", 10);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/**
 * The dialog submit: validate, resolve every number through forge search, and
 * record the facts in the curation store under the workspace key. Pure apart
 * from the store write, so the dialog shell stays thin and this is fully
 * testable with a fake search client.
 *
 * Numbers that resolve are attached even when a later one is missing: a list of
 * eight with one stale number should cost that one, not the other seven.
 */
export async function submitAttachPullRequests(input: {
  client: ForgeSearchClient;
  cwd: string;
  workspaceKey: string;
  rawValue: string;
  formatInvalid: () => string;
  formatNotFound: (numbers: number[]) => string;
}): Promise<RelatedPullRequest[]> {
  const numbers = parseAttachPullRequestNumbers(input.rawValue);
  if (numbers === null) {
    throw new Error(input.formatInvalid());
  }
  // Independent round trips, so they go together: eight numbers used to take
  // the sum of sixteen lookups while the dialog said "Saving...".
  const settled = await Promise.all(
    numbers.map(async (number) => {
      try {
        return {
          number,
          facts: await resolvePullRequestForAttach({
            client: input.client,
            cwd: input.cwd,
            number,
          }),
        };
      } catch (error) {
        if (error instanceof AttachPullRequestNotFoundError) {
          return { number, facts: null };
        }
        throw error;
      }
    }),
  );
  const attached: RelatedPullRequest[] = [];
  const missing: number[] = [];
  // Written in the order they were typed, not the order the forge answered.
  for (const entry of settled) {
    if (entry.facts === null) {
      missing.push(entry.number);
      continue;
    }
    pullRequestCurationStore.attach(input.workspaceKey, entry.facts);
    attached.push(entry.facts);
  }
  if (missing.length > 0) {
    throw new Error(input.formatNotFound(missing));
  }
  return attached;
}

/**
 * Attached pull requests keep the facts they had when attached, so one merged since still reads
 * open. This rereads the open ones and records every one whose state moved; it answers how many
 * did. A lookup that fails leaves that entry as it was.
 */
export async function refreshAttachedPullRequests(input: {
  client: ForgeSearchClient;
  cwd: string;
  workspaceKey: string;
  pullRequests: readonly RelatedPullRequest[];
}): Promise<number> {
  const stale = input.pullRequests.filter(
    (pullRequest) => pullRequest.origin === "manual" && pullRequest.state === "open",
  );
  const fresh = await Promise.all(
    stale.map((pullRequest) =>
      resolvePullRequestForAttach({
        client: input.client,
        cwd: input.cwd,
        number: pullRequest.number,
      }).catch(() => null),
    ),
  );
  let changed = 0;
  for (const facts of fresh) {
    if (facts && facts.state !== "open") {
      pullRequestCurationStore.attach(input.workspaceKey, facts);
      changed += 1;
    }
  }
  return changed;
}
