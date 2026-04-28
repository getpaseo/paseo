// Unit tests for integration-context helpers
// Verifies that integration details (title, url, description) are correctly
// extracted when loading tasks — covering metadata, integrations context,
// task-name inference, and prompt enrichment paths.

import { describe, test, expect } from "vitest";
import {
  extractLinkedIntegrations,
  mergeLinkedIntegrationWithRawIssue,
  integrationDisplayName,
} from "./integration-context";
import type { LinkedIntegration } from "./integration-context";
import type { TaskMetadata } from "@/types/integrations";
import type { TaskIntegrationContext } from "@/types/kanban";

// ─── helpers ────────────────────────────────────────────────────────────────

function baseItem(overrides: Partial<LinkedIntegration> = {}): LinkedIntegration {
  return {
    id: "linear",
    identifier: "ABC-1",
    title: "Linked Linear item",
    url: null,
    description: null,
    meta: [],
    ...overrides,
  };
}

// ─── integrationDisplayName ──────────────────────────────────────────────────

describe("integrationDisplayName", () => {
  test("returns correct display name for each provider", () => {
    expect(integrationDisplayName("linear")).toBe("Linear");
    expect(integrationDisplayName("github")).toBe("GitHub");
    expect(integrationDisplayName("jira")).toBe("Jira");
    expect(integrationDisplayName("gitlab")).toBe("GitLab");
    expect(integrationDisplayName("sentry")).toBe("Sentry");
    expect(integrationDisplayName("forgejo")).toBe("Forgejo");
    expect(integrationDisplayName("plain")).toBe("Plain");
  });
});

// ─── extractLinkedIntegrations — metadata path ───────────────────────────────

describe("extractLinkedIntegrations — metadata path", () => {
  test("extracts Linear issue with full details from metadata", () => {
    const metadata: TaskMetadata = {
      linearIssue: {
        id: "issue-1",
        identifier: "BRA-1",
        title: "Get familiar with Linear",
        description: "This is a detailed description",
        url: "https://linear.app/team/issue/BRA-1",
        state: { name: "In Progress" },
        assignee: { name: "Alice" },
        project: { name: "Sprint 1" },
        team: { name: "Backend" },
      },
    };

    const result = extractLinkedIntegrations(metadata);

    expect(result).toHaveLength(1);
    const [item] = result;
    expect(item.id).toBe("linear");
    expect(item.identifier).toBe("BRA-1");
    expect(item.title).toBe("Get familiar with Linear");
    expect(item.description).toBe("This is a detailed description");
    expect(item.url).toBe("https://linear.app/team/issue/BRA-1");
    expect(item.meta).toContain("In Progress");
    expect(item.meta).toContain("Alice");
    expect(item.meta).toContain("Sprint 1");
    expect(item.meta).toContain("Backend");
  });

  test("extracts GitHub issue with full details from metadata", () => {
    const metadata: TaskMetadata = {
      githubIssue: {
        id: 123,
        number: 42,
        title: "Fix authentication bug",
        body: "Steps to reproduce...",
        state: "open",
        url: "https://github.com/org/repo/issues/42",
        repository: "org/repo",
      },
    };

    const result = extractLinkedIntegrations(metadata);

    expect(result).toHaveLength(1);
    const [item] = result;
    expect(item.id).toBe("github");
    expect(item.identifier).toBe("#42");
    expect(item.title).toBe("Fix authentication bug");
    expect(item.description).toBe("Steps to reproduce...");
    expect(item.url).toBe("https://github.com/org/repo/issues/42");
    expect(item.meta).toContain("open");
    expect(item.meta).toContain("org/repo");
  });

  test("extracts Jira issue with full details from metadata", () => {
    const metadata: TaskMetadata = {
      jiraIssue: {
        id: "jira-1",
        key: "PROJ-123",
        title: "Implement payment flow",
        description: "Payment flow description",
        url: "https://org.atlassian.net/browse/PROJ-123",
        status: { name: "To Do" },
        assignee: { name: "Bob" },
        priority: { name: "High" },
      },
    };

    const result = extractLinkedIntegrations(metadata);

    expect(result).toHaveLength(1);
    const [item] = result;
    expect(item.id).toBe("jira");
    expect(item.identifier).toBe("PROJ-123");
    expect(item.title).toBe("Implement payment flow");
    expect(item.url).toBe("https://org.atlassian.net/browse/PROJ-123");
    expect(item.meta).toContain("To Do");
    expect(item.meta).toContain("Bob");
    expect(item.meta).toContain("High");
  });

  test("extracts GitLab issue from metadata", () => {
    const metadata: TaskMetadata = {
      gitlabIssue: {
        id: 1,
        iid: 5,
        title: "Migrate database schema",
        description: "Migration details",
        state: "opened",
        webUrl: "https://gitlab.com/group/project/-/issues/5",
        projectPath: "group/project",
      },
    };

    const result = extractLinkedIntegrations(metadata);
    expect(result).toHaveLength(1);
    const [item] = result;
    expect(item.id).toBe("gitlab");
    expect(item.identifier).toBe("#5");
    expect(item.title).toBe("Migrate database schema");
    expect(item.url).toBe("https://gitlab.com/group/project/-/issues/5");
  });

  test("extracts Forgejo issue from metadata", () => {
    const metadata: TaskMetadata = {
      forgejoIssue: {
        id: 1,
        number: 7,
        title: "Update CI pipeline",
        body: "Pipeline changes",
        state: "open",
        htmlUrl: "https://forgejo.example.com/repo/issues/7",
        repository: { fullName: "user/repo" },
      },
    };

    const result = extractLinkedIntegrations(metadata);
    expect(result).toHaveLength(1);
    const [item] = result;
    expect(item.id).toBe("forgejo");
    expect(item.identifier).toBe("#7");
    expect(item.url).toBe("https://forgejo.example.com/repo/issues/7");
  });

  test("extracts Plain thread from metadata", () => {
    const metadata: TaskMetadata = {
      plainThread: {
        id: "thread-abc",
        title: "Customer support request",
        previewText: "Customer message preview",
        status: "open",
        customer: { fullName: "John Doe" },
      },
    };

    const result = extractLinkedIntegrations(metadata);
    expect(result).toHaveLength(1);
    const [item] = result;
    expect(item.id).toBe("plain");
    expect(item.title).toBe("Customer support request");
    expect(item.description).toBe("Customer message preview");
    expect(item.meta).toContain("open");
    expect(item.meta).toContain("John Doe");
  });

  test("extracts Sentry issue from metadata", () => {
    const metadata: TaskMetadata = {
      sentryIssue: {
        id: "sentry-99",
        title: "TypeError: Cannot read properties of null",
        culprit: "src/components/App.tsx in render",
        level: "error",
        permalink: "https://sentry.io/issues/sentry-99",
      },
    };

    const result = extractLinkedIntegrations(metadata);
    expect(result).toHaveLength(1);
    const [item] = result;
    expect(item.id).toBe("sentry");
    expect(item.identifier).toBe("SENTRY-sentry-99");
    expect(item.title).toBe("TypeError: Cannot read properties of null");
    expect(item.url).toBe("https://sentry.io/issues/sentry-99");
  });

  test("extracts multiple integration issues from metadata", () => {
    const metadata: TaskMetadata = {
      linearIssue: {
        id: "li-1",
        identifier: "ABC-1",
        title: "Linear issue",
        url: "https://linear.app/issue/ABC-1",
      },
      githubIssue: {
        id: 1,
        number: 10,
        title: "GitHub PR",
        url: "https://github.com/org/repo/issues/10",
      },
    };

    const result = extractLinkedIntegrations(metadata);
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.id)).toEqual(["linear", "github"]);
  });

  test("returns empty array when metadata has no integration issues", () => {
    const metadata: TaskMetadata = { initialPrompt: "some prompt", autoApprove: true };
    const result = extractLinkedIntegrations(metadata);
    expect(result).toHaveLength(0);
  });
});

// ─── extractLinkedIntegrations — integrations context path ───────────────────

describe("extractLinkedIntegrations — integrations context fallback", () => {
  test("creates placeholder entry from integrations context when no metadata", () => {
    const integrations: TaskIntegrationContext = { linearIssueId: "BRA-42" };

    const result = extractLinkedIntegrations(undefined, integrations);

    expect(result).toHaveLength(1);
    const [item] = result;
    expect(item.id).toBe("linear");
    expect(item.identifier).toBe("BRA-42");
    expect(item.title).toBe("Linked Linear item");
    expect(item.url).toBeNull();
    expect(item.description).toBeNull();
  });

  test("metadata takes priority over integrations context for same provider", () => {
    const metadata: TaskMetadata = {
      linearIssue: {
        id: "li-1",
        identifier: "BRA-1",
        title: "Real title from metadata",
        url: "https://linear.app/issue/BRA-1",
      },
    };
    const integrations: TaskIntegrationContext = { linearIssueId: "BRA-1" };

    const result = extractLinkedIntegrations(metadata, integrations);

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Real title from metadata");
    expect(result[0].url).toBe("https://linear.app/issue/BRA-1");
  });

  test("integrations context adds entries for providers not in metadata", () => {
    const metadata: TaskMetadata = {
      linearIssue: { id: "li-1", identifier: "BRA-1", title: "Linear issue" },
    };
    const integrations: TaskIntegrationContext = { githubIssueId: "#42" };

    const result = extractLinkedIntegrations(metadata, integrations);

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("linear");
    expect(result[1].id).toBe("github");
    expect(result[1].url).toBeNull();
  });

  test("ignores empty/undefined integration IDs", () => {
    const integrations: TaskIntegrationContext = {
      linearIssueId: "",
      githubIssueId: undefined,
    };

    const result = extractLinkedIntegrations(undefined, integrations);
    expect(result).toHaveLength(0);
  });
});

// ─── extractLinkedIntegrations — task name inference path ────────────────────

describe("extractLinkedIntegrations — task name inference", () => {
  test("infers Linear integration with BRA-1 identifier from task name", () => {
    const result = extractLinkedIntegrations(
      undefined,
      undefined,
      "linear-bra-1-get-familiar-with-linear-1",
    );

    expect(result).toHaveLength(1);
    const [item] = result;
    expect(item.id).toBe("linear");
    expect(item.identifier).toBe("BRA-1");
  });

  test("extracts human-readable title from task name slug", () => {
    const result = extractLinkedIntegrations(
      undefined,
      undefined,
      "linear-bra-1-get-familiar-with-linear-1",
    );

    expect(result[0].title).toBe("get familiar with linear 1");
  });

  test("infers GitHub integration with # prefix from task name", () => {
    const result = extractLinkedIntegrations(undefined, undefined, "github-42-fix-login-bug");

    expect(result).toHaveLength(1);
    const [item] = result;
    expect(item.id).toBe("github");
    expect(item.identifier).toBe("#42");
    expect(item.title).toBe("fix login bug");
  });

  test("infers Jira integration with compound identifier from task name", () => {
    const result = extractLinkedIntegrations(undefined, undefined, "jira-proj-123-refactor-api");

    expect(result).toHaveLength(1);
    const [item] = result;
    expect(item.id).toBe("jira");
    expect(item.identifier).toBe("PROJ-123");
    expect(item.title).toBe("refactor api");
  });

  test("uses placeholder title when task name has only identifier (no title slug)", () => {
    const result = extractLinkedIntegrations(undefined, undefined, "linear-bra-1");

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Linked Linear item");
  });

  test("metadata takes priority over task name inference", () => {
    const metadata: TaskMetadata = {
      linearIssue: {
        id: "li-1",
        identifier: "BRA-1",
        title: "Real issue title",
        url: "https://linear.app/issue/BRA-1",
      },
    };

    const result = extractLinkedIntegrations(metadata, undefined, "linear-bra-1-some-other-slug");

    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Real issue title");
    expect(result[0].url).toBe("https://linear.app/issue/BRA-1");
  });

  test("integrations context takes priority over task name inference", () => {
    const integrations: TaskIntegrationContext = { linearIssueId: "BRA-1" };

    const result = extractLinkedIntegrations(undefined, integrations, "linear-bra-1-some-slug");

    // integrations context is present, so inference should not run
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Linked Linear item"); // from integrations fallback
  });

  test("returns empty array for task name that does not match integration pattern", () => {
    const result = extractLinkedIntegrations(undefined, undefined, "bright-vector-1");
    expect(result).toHaveLength(0);
  });

  test("returns empty array for unrecognized integration prefix", () => {
    const result = extractLinkedIntegrations(undefined, undefined, "notion-page-123-my-task");
    expect(result).toHaveLength(0);
  });
});

// ─── extractLinkedIntegrations — prompt enrichment path ──────────────────────

describe("extractLinkedIntegrations — prompt enrichment", () => {
  test("enriches url and description from prompt block", () => {
    const integrations: TaskIntegrationContext = { linearIssueId: "ABC-1" };
    const prompt = `
Linked Linear issue — ABC-1 - My Issue Title

URL: https://linear.app/team/issue/ABC-1

Issue Description: This is the issue body from the prompt
    `.trim();

    const result = extractLinkedIntegrations(undefined, integrations, undefined, prompt);

    expect(result).toHaveLength(1);
    expect(result[0].url).toBe("https://linear.app/team/issue/ABC-1");
    expect(result[0].description).toBe("This is the issue body from the prompt");
  });

  test("extracts title from prompt block em-dash separator", () => {
    const integrations: TaskIntegrationContext = { linearIssueId: "ABC-1" };
    const prompt =
      "Linked Linear issue — ABC-1 — My Real Title\nURL: https://linear.app/issue/ABC-1";

    const result = extractLinkedIntegrations(undefined, integrations, undefined, prompt);

    expect(result[0].title).toBe("My Real Title");
  });

  test("does not overwrite metadata url/description with prompt data", () => {
    const metadata: TaskMetadata = {
      linearIssue: {
        id: "li-1",
        identifier: "ABC-1",
        title: "Metadata title",
        url: "https://linear.app/issue/ABC-1",
        description: "Metadata description",
      },
    };
    const prompt =
      "Linked Linear ABC-1\nURL: https://prompt-url.com\nIssue Description: Prompt description";

    const result = extractLinkedIntegrations(metadata, undefined, undefined, prompt);

    // metadata url/description are already present so enrichFromPrompt won't overwrite them
    expect(result[0].url).toBe("https://linear.app/issue/ABC-1");
    expect(result[0].description).toBe("Metadata description");
  });
});

// ─── mergeLinkedIntegrationWithRawIssue ──────────────────────────────────────

describe("mergeLinkedIntegrationWithRawIssue", () => {
  test("merges Linear raw issue data into LinkedIntegration", () => {
    const base = baseItem({ id: "linear", identifier: "ABC-1" });
    const raw = {
      identifier: "ABC-1",
      title: "Real Issue Title",
      description: "Full description from API",
      url: "https://linear.app/issue/ABC-1",
      state: { name: "In Progress" },
      assignee: { name: "Alice" },
      project: { name: "Q2" },
      team: { name: "Frontend" },
    };

    const merged = mergeLinkedIntegrationWithRawIssue(base, raw);

    expect(merged.title).toBe("Real Issue Title");
    expect(merged.description).toBe("Full description from API");
    expect(merged.url).toBe("https://linear.app/issue/ABC-1");
    expect(merged.meta).toContain("In Progress");
    expect(merged.meta).toContain("Alice");
    expect(merged.meta).toContain("Q2");
    expect(merged.meta).toContain("Frontend");
  });

  test("merges GitHub raw issue data into LinkedIntegration", () => {
    const base = baseItem({ id: "github", identifier: "#10" });
    const raw = {
      number: 10,
      title: "GitHub Issue Title",
      body: "Issue body text",
      url: "https://github.com/org/repo/issues/10",
      state: "open",
      repository: "org/repo",
    };

    const merged = mergeLinkedIntegrationWithRawIssue(base, raw);

    expect(merged.title).toBe("GitHub Issue Title");
    expect(merged.description).toBe("Issue body text");
    expect(merged.url).toBe("https://github.com/org/repo/issues/10");
    expect(merged.meta).toContain("open");
    expect(merged.meta).toContain("org/repo");
  });

  test("merges Jira raw issue data into LinkedIntegration", () => {
    const base = baseItem({ id: "jira", identifier: "PROJ-1" });
    const raw = {
      key: "PROJ-1",
      title: "Jira Issue",
      description: "Jira description",
      url: "https://org.atlassian.net/browse/PROJ-1",
      status: { name: "Done" },
      assignee: { name: "Bob" },
      priority: { name: "Critical" },
    };

    const merged = mergeLinkedIntegrationWithRawIssue(base, raw);

    expect(merged.identifier).toBe("PROJ-1");
    expect(merged.url).toBe("https://org.atlassian.net/browse/PROJ-1");
    expect(merged.meta).toContain("Done");
    expect(merged.meta).toContain("Bob");
    expect(merged.meta).toContain("Critical");
  });

  test("merges GitLab raw issue data", () => {
    const base = baseItem({ id: "gitlab", identifier: "#5" });
    const raw = {
      iid: 5,
      title: "GitLab issue",
      description: "GitLab description",
      webUrl: "https://gitlab.com/group/project/-/issues/5",
      state: "opened",
      projectPath: "group/project",
    };

    const merged = mergeLinkedIntegrationWithRawIssue(base, raw);

    expect(merged.url).toBe("https://gitlab.com/group/project/-/issues/5");
    expect(merged.meta).toContain("opened");
  });

  test("merges Forgejo raw issue data", () => {
    const base = baseItem({ id: "forgejo", identifier: "#7" });
    const raw = {
      number: 7,
      title: "Forgejo issue",
      body: "Forgejo body",
      htmlUrl: "https://forgejo.example.com/issues/7",
      state: "open",
      repository: { fullName: "user/repo" },
    };

    const merged = mergeLinkedIntegrationWithRawIssue(base, raw);

    expect(merged.url).toBe("https://forgejo.example.com/issues/7");
    expect(merged.description).toBe("Forgejo body");
  });

  test("merges Sentry raw issue data", () => {
    const base = baseItem({ id: "sentry", identifier: "SENTRY-99" });
    const raw = {
      id: "99",
      title: "Sentry Error",
      culprit: "src/App.tsx in render",
      permalink: "https://sentry.io/issues/99",
      level: "error",
    };

    const merged = mergeLinkedIntegrationWithRawIssue(base, raw);

    expect(merged.url).toBe("https://sentry.io/issues/99");
    expect(merged.description).toBe("src/App.tsx in render");
  });

  test("does not duplicate existing meta entries", () => {
    const base = baseItem({
      id: "linear",
      identifier: "ABC-1",
      meta: ["In Progress"],
    });
    const raw = {
      state: { name: "In Progress" }, // already in meta
      team: { name: "Backend" },
    };

    const merged = mergeLinkedIntegrationWithRawIssue(base, raw);

    const inProgressCount = merged.meta.filter((m) => m === "In Progress").length;
    expect(inProgressCount).toBe(1);
    expect(merged.meta).toContain("Backend");
  });

  test("preserves existing base values when raw does not provide them", () => {
    const base = baseItem({
      id: "linear",
      identifier: "ABC-1",
      title: "Existing title",
      url: "https://existing-url.com",
      description: "Existing description",
    });
    const raw = {}; // empty raw

    const merged = mergeLinkedIntegrationWithRawIssue(base, raw);

    expect(merged.title).toBe("Existing title");
    expect(merged.url).toBe("https://existing-url.com");
    expect(merged.description).toBe("Existing description");
  });
});
