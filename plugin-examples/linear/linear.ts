import { z } from "zod";

const LinearIssueSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  url: z.string(),
  priorityLabel: z.string(),
  state: z.object({ name: z.string() }),
  assignee: z.object({ name: z.string() }).nullable(),
  project: z.object({ name: z.string() }).nullable(),
  labels: z.object({ nodes: z.array(z.object({ name: z.string() })) }),
});

const LinearGraphqlErrorSchema = z.object({ message: z.string() }).passthrough();
const ExactIssueResponseSchema = z.object({
  data: z.object({ issue: LinearIssueSchema.nullable() }).nullable().optional(),
  errors: z.array(LinearGraphqlErrorSchema).optional(),
});
const IssueSearchResponseSchema = z.object({
  data: z
    .object({ issues: z.object({ nodes: z.array(LinearIssueSchema) }) })
    .nullable()
    .optional(),
  errors: z.array(LinearGraphqlErrorSchema).optional(),
});

const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  url
  priorityLabel
  state { name }
  assignee { name }
  project { name }
  labels { nodes { name } }
`;

const EXACT_ISSUE_QUERY = `
  query PaseoLinearIssue($id: String!) {
    issue(id: $id) { ${ISSUE_FIELDS} }
  }
`;

const SEARCH_ISSUES_QUERY = `
  query PaseoLinearIssues($filter: IssueFilter) {
    issues(first: 20, filter: $filter, orderBy: updatedAt) {
      nodes { ${ISSUE_FIELDS} }
    }
  }
`;

const LINEAR_IDENTIFIER = /^[A-Z][A-Z0-9]+-\d+$/i;

export interface LinearAttachmentItem {
  id: string;
  identifier: string;
  title: string;
  subtitle?: string;
  url: string;
  text: string;
  resourceType: string;
}

export interface LinearIssueSearch {
  search(query: string): Promise<{ items: LinearAttachmentItem[] }>;
}

interface LinearIssueSearchOptions {
  apiKey: string;
  endpoint?: string;
  request?: typeof fetch;
}

interface GraphqlRequest {
  query: string;
  variables: Record<string, unknown>;
}

class LinearApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinearApiError";
  }
}

function issueSubtitle(issue: z.infer<typeof LinearIssueSchema>): string | undefined {
  const parts = [issue.state.name, issue.assignee?.name].filter(
    (part): part is string => typeof part === "string" && part.length > 0,
  );
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function issueText(issue: z.infer<typeof LinearIssueSchema>): string {
  const labels = issue.labels.nodes.map((label) => label.name).join(", ");
  const lines = [
    `Linear issue ${issue.identifier}: ${issue.title}`,
    `URL: ${issue.url}`,
    `Status: ${issue.state.name}`,
    `Priority: ${issue.priorityLabel}`,
  ];
  if (issue.assignee) lines.push(`Assignee: ${issue.assignee.name}`);
  if (issue.project) lines.push(`Project: ${issue.project.name}`);
  if (labels) lines.push(`Labels: ${labels}`);
  lines.push("", issue.description ?? "No description.");
  return lines.join("\n");
}

function toAttachmentItem(issue: z.infer<typeof LinearIssueSchema>): LinearAttachmentItem {
  const subtitle = issueSubtitle(issue);
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    ...(subtitle ? { subtitle } : {}),
    url: issue.url,
    text: issueText(issue),
    resourceType: "issue",
  };
}

function describeHttpFailure(status: number): string {
  if (status === 401 || status === 403) return "Linear rejected LINEAR_API_KEY";
  if (status === 429) return "Linear rate limit reached. Try again shortly";
  return `Linear API request failed with HTTP ${status}`;
}

function throwGraphqlErrors(errors: Array<{ message: string }> | undefined): void {
  if (!errors || errors.length === 0) return;
  throw new LinearApiError(errors.map((error) => error.message).join("; "));
}

export function createLinearIssueSearch(options: LinearIssueSearchOptions): LinearIssueSearch {
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw new LinearApiError("Set LINEAR_API_KEY in the daemon environment");
  const endpoint = options.endpoint ?? "https://api.linear.app/graphql";
  const request = options.request ?? fetch;

  async function graphql(body: GraphqlRequest): Promise<unknown> {
    const response = await request(endpoint, {
      method: "POST",
      headers: {
        Authorization: apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new LinearApiError(describeHttpFailure(response.status));
    return response.json();
  }

  async function findExact(identifier: string): Promise<LinearAttachmentItem[]> {
    const response = ExactIssueResponseSchema.parse(
      await graphql({ query: EXACT_ISSUE_QUERY, variables: { id: identifier } }),
    );
    throwGraphqlErrors(response.errors);
    return response.data?.issue ? [toAttachmentItem(response.data.issue)] : [];
  }

  async function searchTitles(query: string): Promise<LinearAttachmentItem[]> {
    const filter = query ? { title: { containsIgnoreCase: query } } : null;
    const response = IssueSearchResponseSchema.parse(
      await graphql({ query: SEARCH_ISSUES_QUERY, variables: { filter } }),
    );
    throwGraphqlErrors(response.errors);
    if (!response.data) throw new LinearApiError("Linear returned no issue data");
    return response.data.issues.nodes.map(toAttachmentItem);
  }

  return {
    async search(query: string) {
      const normalized = query.trim();
      if (LINEAR_IDENTIFIER.test(normalized)) {
        return { items: await findExact(normalized.toUpperCase()) };
      }
      const items = await searchTitles(normalized);
      return { items };
    },
  };
}
