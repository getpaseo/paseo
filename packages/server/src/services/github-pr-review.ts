import { z } from "zod";

export type GithubReviewLineSide = "old" | "new";
export type GithubReviewSubmitEvent = "comment" | "approve" | "request_changes";

export interface GithubReviewIdentity {
  cwd: string;
  repoOwner: string;
  repoName: string;
  prNumber: number;
}

export interface GithubReviewThreadInput extends GithubReviewIdentity {
  path: string;
  side: GithubReviewLineSide;
  line: number;
  body: string;
}

export interface GithubReviewWriteResult {
  reviewId: string | null;
  commentId: string | null;
  threadId: string | null;
}

type RunGhJson = <T>(
  args: string[],
  runOptions: { cwd: string },
  schema: z.ZodType<T>,
  emptyFallback: string,
) => Promise<T>;

const PullRequestIdQuerySchema = z.object({
  data: z
    .object({
      repository: z
        .object({
          pullRequest: z
            .object({
              id: z.string(),
            })
            .nullable(),
        })
        .nullable(),
    })
    .optional(),
});

const AddReviewCommentSchema = z.object({
  data: z
    .object({
      addPullRequestReviewThreadReply: z
        .object({
          comment: z
            .object({
              id: z.string(),
            })
            .nullable(),
        })
        .nullable(),
    })
    .optional(),
});

const AddReviewSchema = z.object({
  data: z
    .object({
      addPullRequestReview: z
        .object({
          pullRequestReview: z
            .object({
              id: z.string(),
            })
            .nullable(),
        })
        .nullable(),
    })
    .optional(),
});

const AddReviewThreadSchema = z.object({
  data: z
    .object({
      addPullRequestReviewThread: z
        .object({
          thread: z
            .object({
              id: z.string(),
            })
            .nullable(),
        })
        .nullable(),
    })
    .optional(),
});

const SubmitReviewSchema = z.object({
  data: z
    .object({
      submitPullRequestReview: z
        .object({
          pullRequestReview: z
            .object({
              id: z.string(),
            })
            .nullable(),
        })
        .nullable(),
    })
    .optional(),
});

const DeleteReviewSchema = z.object({
  data: z
    .object({
      deletePullRequestReview: z
        .object({
          pullRequestReview: z
            .object({
              id: z.string(),
            })
            .nullable(),
        })
        .nullable(),
    })
    .optional(),
});

const PULL_REQUEST_ID_QUERY = `
query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { id }
  }
}`;

const REPLY_MUTATION = `
mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
    comment { id }
  }
}`;

const PUBLISH_COMMENT_MUTATION = `
mutation($pullRequestId: ID!, $body: String!, $path: String!, $line: Int!, $side: DiffSide!) {
  addPullRequestReview(input: {
    pullRequestId: $pullRequestId
    event: COMMENT
    threads: [{ path: $path, body: $body, line: $line, side: $side }]
  }) {
    pullRequestReview { id }
  }
}`;

const START_REVIEW_MUTATION = `
mutation($pullRequestId: ID!, $body: String!, $path: String!, $line: Int!, $side: DiffSide!) {
  addPullRequestReview(input: {
    pullRequestId: $pullRequestId
    threads: [{ path: $path, body: $body, line: $line, side: $side }]
  }) {
    pullRequestReview { id }
  }
}`;

const ADD_THREAD_MUTATION = `
mutation($pullRequestReviewId: ID!, $body: String!, $path: String!, $line: Int!, $side: DiffSide!) {
  addPullRequestReviewThread(input: {
    pullRequestReviewId: $pullRequestReviewId
    path: $path
    body: $body
    line: $line
    side: $side
  }) {
    thread { id }
  }
}`;

const SUBMIT_REVIEW_MUTATION = `
mutation($pullRequestReviewId: ID!, $event: PullRequestReviewEvent!, $body: String) {
  submitPullRequestReview(input: {
    pullRequestReviewId: $pullRequestReviewId
    event: $event
    body: $body
  }) {
    pullRequestReview { id }
  }
}`;

const CANCEL_REVIEW_MUTATION = `
mutation($pullRequestReviewId: ID!) {
  deletePullRequestReview(input: { pullRequestReviewId: $pullRequestReviewId }) {
    pullRequestReview { id }
  }
}`;

function graphqlArgs(query: string, variables: Record<string, string | number>): string[] {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    if (typeof value === "number") {
      args.push("-F", `${key}=${value}`);
    } else {
      args.push("-f", `${key}=${value}`);
    }
  }
  return args;
}

function diffSide(side: GithubReviewLineSide): "LEFT" | "RIGHT" {
  return side === "old" ? "LEFT" : "RIGHT";
}

function submitEvent(event: GithubReviewSubmitEvent): "COMMENT" | "APPROVE" | "REQUEST_CHANGES" {
  if (event === "approve") return "APPROVE";
  if (event === "request_changes") return "REQUEST_CHANGES";
  return "COMMENT";
}

export function createGithubPrReviewApi(runGhJson: RunGhJson) {
  async function pullRequestId(input: GithubReviewIdentity): Promise<string> {
    const parsed = await runGhJson(
      graphqlArgs(PULL_REQUEST_ID_QUERY, {
        owner: input.repoOwner,
        name: input.repoName,
        number: input.prNumber,
      }),
      { cwd: input.cwd },
      PullRequestIdQuerySchema,
      "{}",
    );
    const id = parsed.data?.repository?.pullRequest?.id;
    if (!id) {
      throw new Error("Pull request not found");
    }
    return id;
  }

  return {
    async reply(input: GithubReviewIdentity & { threadId: string; body: string }) {
      const parsed = await runGhJson(
        graphqlArgs(REPLY_MUTATION, { threadId: input.threadId, body: input.body }),
        { cwd: input.cwd },
        AddReviewCommentSchema,
        "{}",
      );
      return {
        reviewId: null,
        commentId: parsed.data?.addPullRequestReviewThreadReply?.comment?.id ?? null,
        threadId: input.threadId,
      } satisfies GithubReviewWriteResult;
    },

    async comment(input: GithubReviewThreadInput) {
      const id = await pullRequestId(input);
      const parsed = await runGhJson(
        graphqlArgs(PUBLISH_COMMENT_MUTATION, {
          pullRequestId: id,
          body: input.body,
          path: input.path,
          line: input.line,
          side: diffSide(input.side),
        }),
        { cwd: input.cwd },
        AddReviewSchema,
        "{}",
      );
      return {
        reviewId: parsed.data?.addPullRequestReview?.pullRequestReview?.id ?? null,
        commentId: null,
        threadId: null,
      } satisfies GithubReviewWriteResult;
    },

    async draft(input: GithubReviewThreadInput & { reviewId?: string }) {
      if (input.reviewId) {
        const parsed = await runGhJson(
          graphqlArgs(ADD_THREAD_MUTATION, {
            pullRequestReviewId: input.reviewId,
            body: input.body,
            path: input.path,
            line: input.line,
            side: diffSide(input.side),
          }),
          { cwd: input.cwd },
          AddReviewThreadSchema,
          "{}",
        );
        return {
          reviewId: input.reviewId,
          commentId: null,
          threadId: parsed.data?.addPullRequestReviewThread?.thread?.id ?? null,
        } satisfies GithubReviewWriteResult;
      }
      const id = await pullRequestId(input);
      const parsed = await runGhJson(
        graphqlArgs(START_REVIEW_MUTATION, {
          pullRequestId: id,
          body: input.body,
          path: input.path,
          line: input.line,
          side: diffSide(input.side),
        }),
        { cwd: input.cwd },
        AddReviewSchema,
        "{}",
      );
      return {
        reviewId: parsed.data?.addPullRequestReview?.pullRequestReview?.id ?? null,
        commentId: null,
        threadId: null,
      } satisfies GithubReviewWriteResult;
    },

    async submit(
      input: GithubReviewIdentity & {
        reviewId: string;
        event: GithubReviewSubmitEvent;
        body?: string;
      },
    ) {
      const parsed = await runGhJson(
        graphqlArgs(SUBMIT_REVIEW_MUTATION, {
          pullRequestReviewId: input.reviewId,
          event: submitEvent(input.event),
          ...(input.body ? { body: input.body } : {}),
        }),
        { cwd: input.cwd },
        SubmitReviewSchema,
        "{}",
      );
      return {
        reviewId: parsed.data?.submitPullRequestReview?.pullRequestReview?.id ?? input.reviewId,
        commentId: null,
        threadId: null,
      } satisfies GithubReviewWriteResult;
    },

    async cancel(input: GithubReviewIdentity & { reviewId: string }) {
      const parsed = await runGhJson(
        graphqlArgs(CANCEL_REVIEW_MUTATION, { pullRequestReviewId: input.reviewId }),
        { cwd: input.cwd },
        DeleteReviewSchema,
        "{}",
      );
      return {
        reviewId: parsed.data?.deletePullRequestReview?.pullRequestReview?.id ?? input.reviewId,
        commentId: null,
        threadId: null,
      } satisfies GithubReviewWriteResult;
    },
  };
}
