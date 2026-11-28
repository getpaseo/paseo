import { z } from "zod";
import type { ChangeRequestSnapshot } from "./change-request-source.js";

const PAGE_SIZE = 100;
// GitHub charges GraphQL points for requested nested connections, even on quiet PRs.
const REVIEW_THREAD_PAGE_SIZE = 20;
export const GITHUB_POLL_CHECK_CONTEXT_FIELDS = `
  __typename
  ... on CheckRun {
    id databaseId name status conclusion detailsUrl startedAt completedAt
    checkSuite { workflowRun { databaseId workflow { name } } }
  }
  ... on StatusContext { id context state targetUrl createdAt }
`;

export function resolveGitHubChangeRequest(input: string): string {
  const match =
    /^https:\/\/([a-z0-9.-]+)\/([a-z0-9_-]+)\/([a-z0-9_.-]+)\/pull\/(\d+)\/?(?:[?#][^\s]*)?$/i.exec(
      input.trim(),
    );
  if (!match) throw new Error("Enter a GitHub pull request URL.");
  const [, hostname, owner, repo, number] = match;
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const id = Number(number);
  if (!Number.isInteger(id) || id < 1 || id > 2_147_483_647 || repo === "." || repo === "..") {
    throw new Error("Enter a GitHub pull request URL.");
  }
  return `https://${host}/${owner.toLowerCase()}/${repo.toLowerCase()}/pull/${id}`;
}

function identity(url: string) {
  const address = new URL(url);
  const [, owner, repo, , number] = address.pathname.split("/");
  return { host: address.hostname, owner, repo, number: Number(number) };
}

export function githubChangeRequestHost(url: string): string {
  return identity(url).host;
}

export function describeGitHubChangeRequest(url: string): string {
  const { host, owner, repo, number } = identity(url);
  const project = host === "github.com" ? `${owner}/${repo}` : `${host}/${owner}/${repo}`;
  return `${project} #${number}`;
}

const pageSchema = z.object({
  nodes: z.array(z.unknown()),
  pageInfo: z.object({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
});
const rollupSchema = z.object({ state: z.string(), contexts: pageSchema });
const failedStates = new Set([
  "FAILURE",
  "ERROR",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
]);
const checkUrlSchema = z.url({ protocol: /^https?$/ });
const checkSchema = z
  .discriminatedUnion("__typename", [
    z.object({
      __typename: z.literal("CheckRun"),
      id: z.string(),
      name: z.string(),
      status: z.string(),
      conclusion: z.string().nullable(),
      detailsUrl: z.string().nullish(),
    }),
    z.object({
      __typename: z.literal("StatusContext"),
      id: z.string(),
      context: z.string(),
      targetUrl: z.string().nullish(),
      state: z.string(),
    }),
  ])
  .transform((check): ChangeRequestSnapshot["checks"][number] => {
    if (check.__typename === "CheckRun") {
      const status = check.status === "COMPLETED" ? check.conclusion : "PENDING";
      return {
        id: check.id,
        name: check.name,
        state: checkState(status),
        url: checkUrlSchema.safeParse(check.detailsUrl).data,
      };
    }
    return {
      id: check.id,
      name: check.context,
      state: checkState(check.state),
      url: checkUrlSchema.safeParse(check.targetUrl).data,
    };
  });

function checkState(status: string | null): ChangeRequestSnapshot["checksState"] {
  if (status === "SUCCESS") return "passed";
  if (status === "EXPECTED" || status === "PENDING") return "pending";
  if (status && failedStates.has(status)) return "failed";
  return "neutral";
}

const activitySchema = z.object({ id: z.string(), url: z.string().url() });
const reviewSchema = activitySchema.extend({ submittedAt: z.string().nullable() });
const inlineSchema = activitySchema.extend({ publishedAt: z.string().nullable() });
const prStates = { OPEN: "open", CLOSED: "closed", MERGED: "merged" } as const;
const prSchema = z.object({
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  headRefOid: z.string(),
  reviewDecision: z.string().nullable(),
  statusCheckRollup: rollupSchema.nullable(),
  comments: pageSchema,
  reviews: pageSchema,
  reviewThreads: pageSchema,
});

function connection(name: string, fields: string, cursor?: string, size = PAGE_SIZE) {
  return `${name}(first: ${size}${cursor ? `, after: ${JSON.stringify(cursor)}` : ""}) {
    pageInfo { hasNextPage endCursor }
    nodes { ${fields} }
  }`;
}

function conversation(cursor?: string) {
  return `comments(last: ${PAGE_SIZE}${cursor ? `, before: ${JSON.stringify(cursor)}` : ""}) {
    pageInfo { hasNextPage: hasPreviousPage endCursor: startCursor }
    nodes { id url }
  }`;
}

function pullRequest(url: string, fields: string) {
  const { owner, repo, number } = identity(url);
  return `repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(repo)}) {
    pullRequest(number: ${number}) { ${fields} }
  }`;
}

function thread(id: string, fields: string) {
  return `node(id: ${JSON.stringify(id)}) { ... on PullRequestReviewThread { ${fields} } }`;
}

interface PageRead {
  url: string;
  selection: string;
  accept(value: unknown): void;
}

interface ChangeRequestPageSelection {
  url: string;
  graphql: string;
}

interface ReadOptions {
  read(selections: ChangeRequestPageSelection[]): Promise<Record<string, unknown>>;
  batchSize: number;
  firstBatchSize: number;
  onChecks(url: string, headSha: string, contexts: unknown[]): void;
  knownActivity(url: string): ReadonlySet<string> | undefined;
  isObserved(url: string): boolean;
}

const pullRequestResult = z
  .object({ pullRequest: z.unknown() })
  .transform((result) => result.pullRequest);
const threadResult = z.object({ comments: pageSchema });
const reviewFields = "id url submittedAt";
const inlineFields = "id url publishedAt";
const threadFields = `id ${connection("comments", inlineFields, undefined, 10)}`;

export async function readGitHubChangeRequests(
  urls: string[],
  { read, batchSize, firstBatchSize, onChecks, knownActivity, isObserved }: ReadOptions,
): Promise<Map<string, ChangeRequestSnapshot | Error>> {
  const snapshots = new Map<string, ChangeRequestSnapshot>();
  const failed = new Map<string, Error>();
  const pending: PageRead[] = [];

  function schedulePages(
    url: string,
    page: z.infer<typeof pageSchema>,
    consume: (nodes: unknown[]) => boolean | void,
    select: (cursor: string) => string,
    extract: (value: unknown) => z.infer<typeof pageSchema>,
    cursors = new Set<string>(),
  ): void {
    if (consume(page.nodes) === false || !page.pageInfo.hasNextPage) return;
    const cursor = page.pageInfo.endCursor;
    if (!cursor || cursors.has(cursor))
      throw new Error("GitHub returned an invalid pagination cursor.");
    cursors.add(cursor);
    pending.push({
      url,
      selection: select(cursor),
      accept: (value) => schedulePages(url, extract(value), consume, select, extract, cursors),
    });
  }

  function schedulePullRequestPages(
    url: string,
    name: string,
    fields: string,
    page: z.infer<typeof pageSchema>,
    consume: (nodes: unknown[]) => void,
    size = PAGE_SIZE,
  ) {
    schedulePages(
      url,
      page,
      consume,
      (cursor) => pullRequest(url, connection(name, fields, cursor, size)),
      (value) => z.record(z.string(), pageSchema).parse(pullRequestResult.parse(value))[name]!,
    );
  }

  for (const url of urls) {
    pending.push({
      url,
      selection: pullRequest(
        url,
        `
        state headRefOid reviewDecision
        statusCheckRollup { state ${connection("contexts", GITHUB_POLL_CHECK_CONTEXT_FIELDS)} }
        ${conversation()}
        ${connection("reviews", reviewFields)}
        ${connection("reviewThreads", threadFields, undefined, REVIEW_THREAD_PAGE_SIZE)}
      `,
      ),
      accept(result) {
        const pr = prSchema.parse(pullRequestResult.parse(result));
        onChecks(url, pr.headRefOid, pr.statusCheckRollup?.contexts.nodes ?? []);
        const snapshot: ChangeRequestSnapshot = {
          state: prStates[pr.state],
          headSha: pr.headRefOid,
          checksState: checkState(pr.statusCheckRollup?.state ?? null),
          checks: [],
          reviewDecision: pr.reviewDecision,
          activity: [],
        };
        snapshots.set(url, snapshot);
        if (pr.statusCheckRollup) {
          schedulePages(
            url,
            pr.statusCheckRollup.contexts,
            (nodes) => {
              snapshot.checks.push(...z.array(checkSchema).parse(nodes));
            },
            (cursor) =>
              pullRequest(
                url,
                `headRefOid statusCheckRollup { state ${connection("contexts", GITHUB_POLL_CHECK_CONTEXT_FIELDS, cursor)} }`,
              ),
            (value) => {
              const next = prSchema
                .pick({ headRefOid: true, statusCheckRollup: true })
                .parse(pullRequestResult.parse(value));
              if (
                next.headRefOid !== pr.headRefOid ||
                next.statusCheckRollup?.state !== pr.statusCheckRollup?.state ||
                !next.statusCheckRollup
              ) {
                throw new Error("The pull request checks changed during pagination.");
              }
              return next.statusCheckRollup.contexts;
            },
          );
        }
        const seen = knownActivity(url);
        schedulePages(
          url,
          pr.comments,
          (nodes) => {
            const comments = z.array(activitySchema).parse(nodes);
            for (const item of comments) {
              if (!seen?.has(item.id)) snapshot.activity.push({ ...item, kind: "comment" });
            }
            // Walk recent comments first and stop when reaching the committed baseline.
            return !comments.some(({ id }) => seen?.has(id));
          },
          (cursor) => pullRequest(url, conversation(cursor)),
          (value) =>
            z.object({ comments: pageSchema }).parse(pullRequestResult.parse(value)).comments,
        );
        schedulePullRequestPages(url, "reviews", reviewFields, pr.reviews, (nodes) => {
          for (const item of z.array(reviewSchema).parse(nodes)) {
            if (item.submittedAt)
              snapshot.activity.push({ id: item.id, url: item.url, kind: "review" });
          }
        });
        schedulePullRequestPages(
          url,
          "reviewThreads",
          threadFields,
          pr.reviewThreads,
          (nodes) => {
            for (const { id, comments } of z
              .array(threadResult.extend({ id: z.string() }))
              .parse(nodes)) {
              const select = (cursor?: string) =>
                thread(id, connection("comments", inlineFields, cursor));
              const extract = (value: unknown) => threadResult.parse(value).comments;
              schedulePages(
                url,
                comments,
                (inlineNodes) => {
                  for (const item of z.array(inlineSchema).parse(inlineNodes)) {
                    if (item.publishedAt)
                      snapshot.activity.push({
                        id: item.id,
                        url: item.url,
                        kind: "inline comment",
                      });
                  }
                },
                select,
                extract,
              );
            }
          },
          REVIEW_THREAD_PAGE_SIZE,
        );
      },
    });
  }

  let pageSize = firstBatchSize;
  while (pending.length) {
    const batch = pending
      .splice(0, pageSize)
      .filter(({ url }) => !failed.has(url) && isObserved(url));
    pageSize = batchSize;
    if (!batch.length) continue;
    try {
      const selections = batch.map(({ url, selection }, index) => ({
        url,
        graphql: `request${index}: ${selection}`,
      }));
      const data = await read(selections);
      for (const [index, page] of batch.entries()) {
        if (failed.has(page.url) || !isObserved(page.url)) continue;
        try {
          page.accept(data[`request${index}`]);
        } catch (cause) {
          failed.set(page.url, new Error(`Could not read ${page.url}.`, { cause }));
        }
      }
    } catch (cause) {
      for (const { url } of batch) {
        failed.set(
          url,
          new Error(`Could not read ${url}. ${cause instanceof Error ? cause.message : ""}`, {
            cause,
          }),
        );
      }
    }
  }

  return new Map(
    urls.filter(isObserved).map((url) => [url, failed.get(url) ?? snapshots.get(url)!]),
  );
}
