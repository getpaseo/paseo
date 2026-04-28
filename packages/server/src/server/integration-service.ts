// integration-service.ts — Validates, persists, and queries external integrations
// Adapted from emdash's per-provider services (LinearService, JiraService, etc.)
//
// Credentials are stored in $HUBCODE_HOME/integrations/<provider>.json
// Tokens are stored alongside (no keytar in daemon context — secured by file permissions).

import fs from "node:fs";
import path from "node:path";
import { resolveHubcodeHome } from "./hubcode-home.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type IntegrationId =
  | "github"
  | "linear"
  | "jira"
  | "gitlab"
  | "plain"
  | "forgejo"
  | "sentry";

export interface IntegrationCredentials {
  [key: string]: string;
}

export interface IntegrationStatusEntry {
  id: string;
  connected: boolean;
  account?: string;
  error?: string;
}

interface StoredIntegration {
  credentials: IntegrationCredentials;
  account?: string;
  connectedAt: string;
}

// ---------------------------------------------------------------------------
// Persistence helpers
// ---------------------------------------------------------------------------

function getIntegrationsDir(): string {
  const dir = path.join(resolveHubcodeHome(), "integrations");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getStorePath(integrationId: string): string {
  return path.join(getIntegrationsDir(), `${integrationId}.json`);
}

function readStored(integrationId: string): StoredIntegration | null {
  try {
    const raw = fs.readFileSync(getStorePath(integrationId), "utf-8");
    return JSON.parse(raw) as StoredIntegration;
  } catch {
    return null;
  }
}

function writeStored(integrationId: string, data: StoredIntegration): void {
  const filePath = getStorePath(integrationId);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function deleteStored(integrationId: string): void {
  try {
    fs.unlinkSync(getStorePath(integrationId));
  } catch {
    // ignore if file doesn't exist
  }
}

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function fetchJSON(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    timeout?: number;
  } = {},
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options.timeout ?? 15_000);

  try {
    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers: options.headers,
      body: options.body,
      signal: controller.signal,
    });

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    return { ok: response.ok, status: response.status, data };
  } finally {
    clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------------------
// Per-provider validators
// ---------------------------------------------------------------------------

async function validateGitHub(
  creds: IntegrationCredentials,
): Promise<{ account?: string; error?: string }> {
  const token = creds.token;
  if (!token) return { error: "Token is required" };

  const result = await fetchJSON("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "hubcode-daemon",
    },
  });

  if (!result.ok) return { error: `GitHub API returned ${result.status}` };
  const data = result.data as { login?: string };
  return { account: data.login ?? "connected" };
}

async function validateLinear(
  creds: IntegrationCredentials,
): Promise<{ account?: string; error?: string }> {
  const token = creds.token;
  if (!token) return { error: "API key is required" };

  const body = JSON.stringify({
    query: `{ viewer { id name email organization { name } } }`,
  });

  console.log(`[validateLinear] request:`, {
    tokenLength: token.length,
    tokenPrefix: token.slice(0, 8) + "...",
    bodyLength: body.length,
    body,
  });

  const result = await fetchJSON("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: token,
    },
    body,
  });

  console.log(`[validateLinear] response:`, {
    ok: result.ok,
    status: result.status,
    data: JSON.stringify(result.data).slice(0, 500),
  });

  if (!result.ok) {
    const errBody =
      typeof result.data === "object" && result.data !== null ? JSON.stringify(result.data) : "";
    return { error: `Linear API returned ${result.status}${errBody ? `: ${errBody}` : ""}` };
  }
  const data = result.data as {
    data?: { viewer?: { organization?: { name?: string }; name?: string } };
  };
  const org = data?.data?.viewer?.organization?.name;
  const name = data?.data?.viewer?.name;
  return { account: org ?? name ?? "connected" };
}

async function validateJira(
  creds: IntegrationCredentials,
): Promise<{ account?: string; error?: string }> {
  const { site, email, token } = creds;
  if (!site || !email || !token) return { error: "Site URL, email, and API token are required" };

  const baseUrl = site.replace(/\/$/, "");
  const basicAuth = Buffer.from(`${email}:${token}`).toString("base64");

  const result = await fetchJSON(`${baseUrl}/rest/api/3/myself`, {
    headers: {
      Authorization: `Basic ${basicAuth}`,
      Accept: "application/json",
    },
  });

  if (!result.ok) return { error: `Jira API returned ${result.status}` };
  const data = result.data as { displayName?: string; errorMessages?: string[] };
  if (data.errorMessages?.length) return { error: data.errorMessages[0] };
  return { account: data.displayName ?? email };
}

async function validateGitLab(
  creds: IntegrationCredentials,
): Promise<{ account?: string; error?: string }> {
  const { instanceUrl, token } = creds;
  if (!instanceUrl || !token) return { error: "Instance URL and token are required" };

  const baseUrl = instanceUrl.replace(/\/$/, "");
  const result = await fetchJSON(`${baseUrl}/api/v4/user`, {
    headers: { "PRIVATE-TOKEN": token },
  });

  if (!result.ok) return { error: `GitLab API returned ${result.status}` };
  const data = result.data as { username?: string };
  return { account: data.username ?? "connected" };
}

async function validatePlain(
  creds: IntegrationCredentials,
): Promise<{ account?: string; error?: string }> {
  const token = creds.token;
  if (!token) return { error: "API key is required" };

  const result = await fetchJSON("https://core-api.uk.plain.com/graphql/v1", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      query: `{ myWorkspace { id publicName } }`,
    }),
  });

  if (!result.ok) return { error: `Plain API returned ${result.status}` };
  const data = result.data as { data?: { myWorkspace?: { publicName?: string } } };
  return { account: data?.data?.myWorkspace?.publicName ?? "connected" };
}

async function validateForgejo(
  creds: IntegrationCredentials,
): Promise<{ account?: string; error?: string }> {
  const { instanceUrl, token } = creds;
  if (!instanceUrl || !token) return { error: "Instance URL and token are required" };

  const baseUrl = instanceUrl.replace(/\/$/, "");
  const result = await fetchJSON(`${baseUrl}/api/v1/user`, {
    headers: { Authorization: `token ${token}` },
  });

  if (!result.ok) return { error: `Forgejo API returned ${result.status}` };
  const data = result.data as { login?: string };
  return { account: data.login ?? "connected" };
}

async function validateSentry(
  creds: IntegrationCredentials,
): Promise<{ account?: string; error?: string }> {
  const token = creds.token;
  if (!token) return { error: "Auth token is required" };

  const result = await fetchJSON("https://sentry.io/api/0/organizations/", {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!result.ok) return { error: `Sentry API returned ${result.status}` };
  const data = result.data as Array<{ slug?: string; name?: string }>;
  if (!Array.isArray(data) || data.length === 0) return { error: "No organizations found" };
  return { account: data[0]?.name ?? data[0]?.slug ?? "connected" };
}

const VALIDATORS: Record<
  IntegrationId,
  (creds: IntegrationCredentials) => Promise<{ account?: string; error?: string }>
> = {
  github: validateGitHub,
  linear: validateLinear,
  jira: validateJira,
  gitlab: validateGitLab,
  plain: validatePlain,
  forgejo: validateForgejo,
  sentry: validateSentry,
};

// ---------------------------------------------------------------------------
// Per-provider issue fetchers
// ---------------------------------------------------------------------------

async function fetchGitHubItems(
  creds: IntegrationCredentials,
  _cwd?: string,
  limit = 30,
): Promise<{ items: Array<Record<string, unknown>>; error?: string }> {
  const token = creds.token;
  if (!token) return { items: [], error: "Not connected" };

  const result = await fetchJSON(
    `https://api.github.com/issues?filter=assigned&state=open&per_page=${limit}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "hubcode-daemon",
      },
    },
  );

  if (!result.ok) return { items: [], error: `GitHub API returned ${result.status}` };
  const data = result.data as Array<Record<string, unknown>>;
  return {
    items: data.map((issue) => ({
      id: String(issue.id),
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      url: issue.html_url,
      repository: (issue.repository as Record<string, unknown>)?.full_name,
    })),
  };
}

async function searchGitHubItems(
  creds: IntegrationCredentials,
  query: string,
  _cwd?: string,
  limit = 20,
): Promise<{ items: Array<Record<string, unknown>>; error?: string }> {
  const token = creds.token;
  if (!token) return { items: [], error: "Not connected" };

  const result = await fetchJSON(
    `https://api.github.com/search/issues?q=${encodeURIComponent(query)}+is:issue&per_page=${limit}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "hubcode-daemon",
      },
    },
  );

  if (!result.ok) return { items: [], error: `GitHub API returned ${result.status}` };
  const data = result.data as { items?: Array<Record<string, unknown>> };
  return {
    items: (data.items ?? []).map((issue) => ({
      id: String(issue.id),
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      url: issue.html_url,
      repository: (issue.repository_url as string)?.split("/").slice(-2).join("/"),
    })),
  };
}

async function fetchLinearItems(
  creds: IntegrationCredentials,
  _cwd?: string,
  limit = 30,
): Promise<{ items: Array<Record<string, unknown>>; error?: string }> {
  const token = creds.token;
  if (!token) return { items: [], error: "Not connected" };

  // Fetch issues from all teams the viewer belongs to (not just assigned to them).
  // This ensures the dropdown shows available issues even when none are assigned.
  // Falls back to assignedIssues if the broader query returns nothing.
  const issueFields = `id identifier title description url state { name } assignee { name } team { name } project { name }`;
  const result = await fetchJSON("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: token,
    },
    body: JSON.stringify({
      query: `{
        issues(first: ${limit}, orderBy: updatedAt, filter: { state: { type: { nin: ["completed", "cancelled"] } } }) {
          nodes { ${issueFields} }
        }
      }`,
    }),
  });

  if (!result.ok) {
    const errBody =
      typeof result.data === "object" && result.data !== null ? JSON.stringify(result.data) : "";
    console.error(`[fetchLinearItems] API error:`, { status: result.status, body: errBody });
    return {
      items: [],
      error: `Linear API returned ${result.status}${errBody ? `: ${errBody}` : ""}`,
    };
  }
  const data = result.data as {
    data?: { issues?: { nodes?: Array<Record<string, unknown>> } };
  };
  const nodes = data?.data?.issues?.nodes ?? [];
  return {
    items: nodes.map((issue) => ({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      url: issue.url,
      state: (issue.state as Record<string, unknown>)?.name,
      assignee: (issue.assignee as Record<string, unknown>)?.name,
      team: (issue.team as Record<string, unknown>)?.name,
      project: (issue.project as Record<string, unknown>)?.name,
    })),
  };
}

async function searchLinearItems(
  creds: IntegrationCredentials,
  query: string,
  _cwd?: string,
  limit = 20,
): Promise<{ items: Array<Record<string, unknown>>; error?: string }> {
  const token = creds.token;
  if (!token) return { items: [], error: "Not connected" };

  const result = await fetchJSON("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: token,
    },
    body: JSON.stringify({
      query: `{
        searchIssues(term: "${query.replace(/"/g, '\\"')}", first: ${limit}) {
          nodes { id identifier title description url state { name } assignee { name } team { name } project { name } }
        }
      }`,
    }),
  });

  if (!result.ok) {
    const errBody =
      typeof result.data === "object" && result.data !== null ? JSON.stringify(result.data) : "";
    console.error(`[searchLinearItems] API error:`, { status: result.status, body: errBody });
    return {
      items: [],
      error: `Linear API returned ${result.status}${errBody ? `: ${errBody}` : ""}`,
    };
  }
  const data = result.data as {
    data?: { searchIssues?: { nodes?: Array<Record<string, unknown>> } };
  };
  const nodes = data?.data?.searchIssues?.nodes ?? [];
  return {
    items: nodes.map((issue) => ({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      url: issue.url,
      state: (issue.state as Record<string, unknown>)?.name,
      assignee: (issue.assignee as Record<string, unknown>)?.name,
      team: (issue.team as Record<string, unknown>)?.name,
      project: (issue.project as Record<string, unknown>)?.name,
    })),
  };
}

async function fetchJiraItems(
  creds: IntegrationCredentials,
  _cwd?: string,
  limit = 30,
): Promise<{ items: Array<Record<string, unknown>>; error?: string }> {
  const { site, email, token } = creds;
  if (!site || !email || !token) return { items: [], error: "Not connected" };

  const baseUrl = site.replace(/\/$/, "");
  const basicAuth = Buffer.from(`${email}:${token}`).toString("base64");
  const jql = encodeURIComponent(
    "assignee = currentUser() AND resolution = Unresolved ORDER BY updated DESC",
  );

  const result = await fetchJSON(
    `${baseUrl}/rest/api/3/search?jql=${jql}&maxResults=${limit}&fields=summary,status,assignee,priority`,
    {
      headers: {
        Authorization: `Basic ${basicAuth}`,
        Accept: "application/json",
      },
    },
  );

  if (!result.ok) return { items: [], error: `Jira API returned ${result.status}` };
  const data = result.data as { issues?: Array<Record<string, unknown>> };
  return {
    items: (data.issues ?? []).map((issue) => {
      const fields = issue.fields as Record<string, unknown> | undefined;
      return {
        id: issue.id,
        key: issue.key,
        title: fields?.summary,
        status: (fields?.status as Record<string, unknown>)?.name,
        assignee: (fields?.assignee as Record<string, unknown>)?.displayName,
        priority: (fields?.priority as Record<string, unknown>)?.name,
        url: `${baseUrl}/browse/${issue.key}`,
      };
    }),
  };
}

async function searchJiraItems(
  creds: IntegrationCredentials,
  query: string,
  _cwd?: string,
  limit = 20,
): Promise<{ items: Array<Record<string, unknown>>; error?: string }> {
  const { site, email, token } = creds;
  if (!site || !email || !token) return { items: [], error: "Not connected" };

  const baseUrl = site.replace(/\/$/, "");
  const basicAuth = Buffer.from(`${email}:${token}`).toString("base64");
  const jql = encodeURIComponent(`text ~ "${query}" OR key = "${query}" ORDER BY updated DESC`);

  const result = await fetchJSON(
    `${baseUrl}/rest/api/3/search?jql=${jql}&maxResults=${limit}&fields=summary,status,assignee,priority`,
    {
      headers: {
        Authorization: `Basic ${basicAuth}`,
        Accept: "application/json",
      },
    },
  );

  if (!result.ok) return { items: [], error: `Jira API returned ${result.status}` };
  const data = result.data as { issues?: Array<Record<string, unknown>> };
  return {
    items: (data.issues ?? []).map((issue) => {
      const fields = issue.fields as Record<string, unknown> | undefined;
      return {
        id: issue.id,
        key: issue.key,
        title: fields?.summary,
        status: (fields?.status as Record<string, unknown>)?.name,
        url: `${baseUrl}/browse/${issue.key}`,
      };
    }),
  };
}

async function fetchGitLabItems(
  creds: IntegrationCredentials,
  _cwd?: string,
  limit = 30,
): Promise<{ items: Array<Record<string, unknown>>; error?: string }> {
  const { instanceUrl, token } = creds;
  if (!instanceUrl || !token) return { items: [], error: "Not connected" };

  const baseUrl = instanceUrl.replace(/\/$/, "");
  const result = await fetchJSON(
    `${baseUrl}/api/v4/issues?state=opened&scope=assigned_to_me&per_page=${limit}`,
    { headers: { "PRIVATE-TOKEN": token } },
  );

  if (!result.ok) return { items: [], error: `GitLab API returned ${result.status}` };
  const data = result.data as Array<Record<string, unknown>>;
  return {
    items: data.map((issue) => ({
      id: issue.id,
      iid: issue.iid,
      title: issue.title,
      description: issue.description,
      state: issue.state,
      webUrl: issue.web_url,
      projectPath: (issue as Record<string, unknown>).references
        ? ((issue as Record<string, unknown>).references as Record<string, unknown>)?.full
        : undefined,
    })),
  };
}

async function searchGitLabItems(
  creds: IntegrationCredentials,
  query: string,
  _cwd?: string,
  limit = 20,
): Promise<{ items: Array<Record<string, unknown>>; error?: string }> {
  const { instanceUrl, token } = creds;
  if (!instanceUrl || !token) return { items: [], error: "Not connected" };

  const baseUrl = instanceUrl.replace(/\/$/, "");
  const result = await fetchJSON(
    `${baseUrl}/api/v4/issues?state=opened&search=${encodeURIComponent(query)}&in=title,description&per_page=${limit}`,
    { headers: { "PRIVATE-TOKEN": token } },
  );

  if (!result.ok) return { items: [], error: `GitLab API returned ${result.status}` };
  const data = result.data as Array<Record<string, unknown>>;
  return {
    items: data.map((issue) => ({
      id: issue.id,
      iid: issue.iid,
      title: issue.title,
      description: issue.description,
      state: issue.state,
      webUrl: issue.web_url,
    })),
  };
}

async function fetchPlainItems(
  creds: IntegrationCredentials,
  _cwd?: string,
  limit = 30,
): Promise<{ items: Array<Record<string, unknown>>; error?: string }> {
  const token = creds.token;
  if (!token) return { items: [], error: "Not connected" };

  const result = await fetchJSON("https://core-api.uk.plain.com/graphql/v1", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      query: `{ threads(first: ${limit}) { edges { node { id externalId title previewText status { __typename } customer { fullName email } } } } }`,
    }),
  });

  if (!result.ok) return { items: [], error: `Plain API returned ${result.status}` };
  const data = result.data as {
    data?: { threads?: { edges?: Array<{ node: Record<string, unknown> }> } };
  };
  const edges = data?.data?.threads?.edges ?? [];
  return {
    items: edges.map((e) => ({
      id: e.node.id,
      externalId: e.node.externalId,
      title: e.node.title,
      previewText: e.node.previewText,
      status: (e.node.status as Record<string, unknown>)?.__typename,
      customer: (e.node.customer as Record<string, unknown>)?.fullName,
    })),
  };
}

async function searchPlainItems(
  creds: IntegrationCredentials,
  query: string,
  cwd?: string,
  limit = 20,
): Promise<{ items: Array<Record<string, unknown>>; error?: string }> {
  // Plain has no server-side search — fetch all and filter client-side
  const all = await fetchPlainItems(creds, cwd, 100);
  if (all.error) return all;
  const q = query.toLowerCase();
  const filtered = all.items.filter(
    (item) =>
      String(item.title ?? "")
        .toLowerCase()
        .includes(q) ||
      String(item.previewText ?? "")
        .toLowerCase()
        .includes(q) ||
      String(item.customer ?? "")
        .toLowerCase()
        .includes(q),
  );
  return { items: filtered.slice(0, limit) };
}

async function fetchForgejoItems(
  creds: IntegrationCredentials,
  _cwd?: string,
  limit = 30,
): Promise<{ items: Array<Record<string, unknown>>; error?: string }> {
  const { instanceUrl, token } = creds;
  if (!instanceUrl || !token) return { items: [], error: "Not connected" };

  // Without repo context, list issues assigned to user across all repos
  const baseUrl = instanceUrl.replace(/\/$/, "");
  const result = await fetchJSON(`${baseUrl}/api/v1/repos/search?limit=${limit}`, {
    headers: { Authorization: `token ${token}` },
  });

  if (!result.ok) return { items: [], error: `Forgejo API returned ${result.status}` };
  // Forgejo doesn't have a global assigned issues endpoint, so we list user's repos
  // and get issues from each (simplified: return empty for now, search works per-repo)
  return { items: [] };
}

async function searchForgejoItems(
  creds: IntegrationCredentials,
  query: string,
  _cwd?: string,
  limit = 20,
): Promise<{ items: Array<Record<string, unknown>>; error?: string }> {
  const { instanceUrl, token } = creds;
  if (!instanceUrl || !token) return { items: [], error: "Not connected" };

  // Search requires owner/repo — simplified: search user's repos
  const baseUrl = instanceUrl.replace(/\/$/, "");
  const result = await fetchJSON(
    `${baseUrl}/api/v1/repos/search?q=${encodeURIComponent(query)}&limit=${limit}`,
    { headers: { Authorization: `token ${token}` } },
  );

  if (!result.ok) return { items: [], error: `Forgejo API returned ${result.status}` };
  return { items: [] };
}

async function fetchSentryItems(
  creds: IntegrationCredentials,
  _cwd?: string,
  limit = 30,
): Promise<{ items: Array<Record<string, unknown>>; error?: string }> {
  const token = creds.token;
  const org = creds.organization;
  if (!token) return { items: [], error: "Not connected" };

  // If no org stored, try to fetch orgs first
  let orgSlug: string = org ?? "";
  if (!orgSlug) {
    const orgsResult = await fetchJSON("https://sentry.io/api/0/organizations/", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!orgsResult.ok) return { items: [], error: `Sentry API returned ${orgsResult.status}` };
    const orgs = orgsResult.data as Array<{ slug?: string }>;
    orgSlug = orgs[0]?.slug ?? "";
    if (!orgSlug) return { items: [], error: "No organization found" };
  }

  const result = await fetchJSON(
    `https://sentry.io/api/0/organizations/${orgSlug}/issues/?query=is:unresolved&limit=${limit}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!result.ok) return { items: [], error: `Sentry API returned ${result.status}` };
  const data = result.data as Array<Record<string, unknown>>;
  return {
    items: data.map((issue) => ({
      id: issue.id,
      title: issue.title,
      culprit: issue.culprit,
      count: issue.count,
      firstSeen: issue.firstSeen,
      lastSeen: issue.lastSeen,
      level: issue.level,
      permalink: issue.permalink,
    })),
  };
}

async function searchSentryItems(
  creds: IntegrationCredentials,
  query: string,
  _cwd?: string,
  limit = 20,
): Promise<{ items: Array<Record<string, unknown>>; error?: string }> {
  const token = creds.token;
  const org = creds.organization;
  if (!token) return { items: [], error: "Not connected" };

  let orgSlug: string = org ?? "";
  if (!orgSlug) {
    const orgsResult = await fetchJSON("https://sentry.io/api/0/organizations/", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!orgsResult.ok) return { items: [], error: `Sentry API returned ${orgsResult.status}` };
    const orgs = orgsResult.data as Array<{ slug?: string }>;
    orgSlug = orgs[0]?.slug ?? "";
    if (!orgSlug) return { items: [], error: "No organization found" };
  }

  const result = await fetchJSON(
    `https://sentry.io/api/0/organizations/${orgSlug}/issues/?query=is:unresolved+${encodeURIComponent(query)}&limit=${limit}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );

  if (!result.ok) return { items: [], error: `Sentry API returned ${result.status}` };
  const data = result.data as Array<Record<string, unknown>>;
  return {
    items: data.map((issue) => ({
      id: issue.id,
      title: issue.title,
      culprit: issue.culprit,
      count: issue.count,
      level: issue.level,
      permalink: issue.permalink,
    })),
  };
}

type FetchFn = (
  creds: IntegrationCredentials,
  cwd?: string,
  limit?: number,
) => Promise<{ items: Array<Record<string, unknown>>; error?: string }>;
type SearchFn = (
  creds: IntegrationCredentials,
  query: string,
  cwd?: string,
  limit?: number,
) => Promise<{ items: Array<Record<string, unknown>>; error?: string }>;

const FETCHERS: Record<IntegrationId, FetchFn> = {
  github: fetchGitHubItems,
  linear: fetchLinearItems,
  jira: fetchJiraItems,
  gitlab: fetchGitLabItems,
  plain: fetchPlainItems,
  forgejo: fetchForgejoItems,
  sentry: fetchSentryItems,
};

const SEARCHERS: Record<IntegrationId, SearchFn> = {
  github: searchGitHubItems,
  linear: searchLinearItems,
  jira: searchJiraItems,
  gitlab: searchGitLabItems,
  plain: searchPlainItems,
  forgejo: searchForgejoItems,
  sentry: searchSentryItems,
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const ALL_IDS: IntegrationId[] = [
  "github",
  "linear",
  "jira",
  "gitlab",
  "plain",
  "forgejo",
  "sentry",
];

export async function listIntegrationStatus(): Promise<IntegrationStatusEntry[]> {
  return ALL_IDS.map((id) => {
    const stored = readStored(id);
    if (!stored) return { id, connected: false };
    return { id, connected: true, account: stored.account };
  });
}

export async function connectIntegration(
  integrationId: string,
  credentials: IntegrationCredentials,
): Promise<{ success: boolean; account?: string; error?: string }> {
  const id = integrationId as IntegrationId;
  const validator = VALIDATORS[id];
  if (!validator) return { success: false, error: `Unknown integration: ${integrationId}` };

  try {
    const result = await validator(credentials);
    if (result.error) return { success: false, error: result.error };

    writeStored(id, {
      credentials,
      account: result.account,
      connectedAt: new Date().toISOString(),
    });

    return { success: true, account: result.account };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Connection failed: ${message}` };
  }
}

export async function disconnectIntegration(integrationId: string): Promise<{ success: boolean }> {
  deleteStored(integrationId);
  return { success: true };
}

export async function searchIntegrationItems(
  integrationId: string,
  query: string,
  cwd?: string,
  limit?: number,
): Promise<{ items: Array<Record<string, unknown>>; error?: string }> {
  const id = integrationId as IntegrationId;
  const stored = readStored(id);
  if (!stored) return { items: [], error: `${integrationId} is not connected` };

  const searcher = SEARCHERS[id];
  if (!searcher) return { items: [], error: `Search not supported for ${integrationId}` };

  try {
    return await searcher(stored.credentials, query, cwd, limit);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { items: [], error: `Search failed: ${message}` };
  }
}

export async function fetchIntegrationItems(
  integrationId: string,
  cwd?: string,
  limit?: number,
): Promise<{ items: Array<Record<string, unknown>>; error?: string }> {
  const id = integrationId as IntegrationId;
  const stored = readStored(id);
  if (!stored) return { items: [], error: `${integrationId} is not connected` };

  const fetcher = FETCHERS[id];
  if (!fetcher) return { items: [], error: `Fetch not supported for ${integrationId}` };

  try {
    return await fetcher(stored.credentials, cwd, limit);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { items: [], error: `Fetch failed: ${message}` };
  }
}
