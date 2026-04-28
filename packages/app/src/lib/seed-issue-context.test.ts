import { describe, expect, test } from "vitest";
import {
  extractIssueContexts,
  formatIssueContext,
  seedIssueContext,
  type IssueContext,
} from "./seed-issue-context";
import type { TaskMetadata } from "@/types/integrations";

describe("extractIssueContexts", () => {
  test("returns empty array for undefined metadata", () => {
    expect(extractIssueContexts(undefined)).toEqual([]);
  });

  test("returns empty array for metadata without issues", () => {
    expect(extractIssueContexts({} as TaskMetadata)).toEqual([]);
  });

  test("extracts Linear issue context", () => {
    const metadata = {
      linearIssue: {
        id: "iss-1",
        identifier: "LIN-42",
        title: "Fix auth bug",
        description: "The login flow is broken",
        url: "https://linear.app/org/issue/LIN-42",
        state: "In Progress",
        assignee: "John Doe",
        team: "Backend",
        project: "Auth",
      },
    } as TaskMetadata;

    const contexts = extractIssueContexts(metadata);
    expect(contexts).toHaveLength(1);
    expect(contexts[0].provider).toBe("Linear");
    expect(contexts[0].identifier).toBe("LIN-42");
    expect(contexts[0].title).toBe("Fix auth bug");
    expect(contexts[0].url).toBe("https://linear.app/org/issue/LIN-42");
    expect(contexts[0].details).toContain("State: In Progress");
    expect(contexts[0].details).toContain("Assignee: John Doe");
    expect(contexts[0].details).toContain("Team: Backend");
    expect(contexts[0].details).toContain("Project: Auth");
    expect(contexts[0].description).toBe("The login flow is broken");
  });

  test("extracts GitHub issue context", () => {
    const metadata = {
      githubIssue: {
        id: 1,
        number: 123,
        title: "Add feature",
        body: "We need to add a new feature",
        state: "open",
        url: "https://github.com/org/repo/issues/123",
        repository: "org/repo",
        assignees: ["alice", "bob"],
      },
    } as TaskMetadata;

    const contexts = extractIssueContexts(metadata);
    expect(contexts).toHaveLength(1);
    expect(contexts[0].provider).toBe("GitHub");
    expect(contexts[0].identifier).toBe("#123");
    expect(contexts[0].details).toContain("State: open");
    expect(contexts[0].details).toContain("Repository: org/repo");
    expect(contexts[0].details).toContain("Assignees: alice, bob");
  });

  test("extracts Jira issue context", () => {
    const metadata = {
      jiraIssue: {
        id: "10001",
        key: "PROJ-456",
        title: "Optimize query",
        description: "Query is too slow",
        status: "To Do",
        assignee: "Jane Smith",
        priority: "High",
        url: "https://org.atlassian.net/browse/PROJ-456",
      },
    } as TaskMetadata;

    const contexts = extractIssueContexts(metadata);
    expect(contexts).toHaveLength(1);
    expect(contexts[0].provider).toBe("Jira");
    expect(contexts[0].identifier).toBe("PROJ-456");
    expect(contexts[0].details).toContain("Status: To Do");
    expect(contexts[0].details).toContain("Priority: High");
  });

  test("extracts Sentry issue context", () => {
    const metadata = {
      sentryIssue: {
        id: "sentry-1",
        title: "TypeError: null is not an object",
        culprit: "app.js in handleClick",
        count: 42,
        level: "error",
        lastSeen: "2024-01-15T10:00:00Z",
        permalink: "https://sentry.io/issues/123/",
      },
    } as TaskMetadata;

    const contexts = extractIssueContexts(metadata);
    expect(contexts).toHaveLength(1);
    expect(contexts[0].provider).toBe("Sentry");
    expect(contexts[0].details).toContain("Level: error");
    expect(contexts[0].details).toContain("Culprit: app.js in handleClick");
    expect(contexts[0].details).toContain("Events: 42");
  });

  test("extracts multiple issue contexts", () => {
    const metadata = {
      linearIssue: {
        id: "iss-1",
        identifier: "LIN-1",
        title: "Linear task",
        url: "https://linear.app/1",
      },
      githubIssue: {
        id: 1,
        number: 10,
        title: "GitHub issue",
        state: "open",
        url: "https://github.com/issue/10",
      },
    } as TaskMetadata;

    const contexts = extractIssueContexts(metadata);
    expect(contexts).toHaveLength(2);
    expect(contexts[0].provider).toBe("Linear");
    expect(contexts[1].provider).toBe("GitHub");
  });
});

describe("formatIssueContext", () => {
  test("formats a basic issue context", () => {
    const ctx: IssueContext = {
      provider: "Linear",
      identifier: "LIN-42",
      title: "Fix auth bug",
      url: "https://linear.app/issue/LIN-42",
      details: ["State: In Progress", "Assignee: John"],
      description: "The login flow is broken.",
    };

    const formatted = formatIssueContext(ctx);
    expect(formatted).toContain("Linked Linear issue: LIN-42");
    expect(formatted).toContain("Fix auth bug");
    expect(formatted).toContain("State: In Progress");
    expect(formatted).toContain("Assignee: John");
    expect(formatted).toContain("URL: https://linear.app/issue/LIN-42");
    expect(formatted).toContain("Issue Description:");
    expect(formatted).toContain("The login flow is broken.");
  });

  test("omits URL when not present", () => {
    const ctx: IssueContext = {
      provider: "Plain",
      identifier: "T-1",
      title: "Support thread",
      details: [],
    };

    const formatted = formatIssueContext(ctx);
    expect(formatted).not.toContain("URL:");
  });

  test("omits description when not present", () => {
    const ctx: IssueContext = {
      provider: "Sentry",
      identifier: "123",
      title: "Error",
      details: ["Level: error"],
    };

    const formatted = formatIssueContext(ctx);
    expect(formatted).not.toContain("Issue Description:");
  });
});

describe("seedIssueContext", () => {
  test("returns null for undefined metadata", () => {
    expect(seedIssueContext(undefined)).toBeNull();
  });

  test("returns null for metadata without issues", () => {
    expect(seedIssueContext({} as TaskMetadata)).toBeNull();
  });

  test("returns formatted context for single issue", () => {
    const metadata = {
      linearIssue: {
        id: "iss-1",
        identifier: "LIN-42",
        title: "Fix auth",
        url: "https://linear.app/42",
        state: "Todo",
      },
    } as TaskMetadata;

    const result = seedIssueContext(metadata);
    expect(result).not.toBeNull();
    expect(result).toContain("Linked Linear issue: LIN-42");
    expect(result).toContain("Fix auth");
  });

  test("separates multiple issues with dividers", () => {
    const metadata = {
      linearIssue: {
        id: "1",
        identifier: "LIN-1",
        title: "Linear task",
      },
      jiraIssue: {
        id: "2",
        key: "PROJ-1",
        title: "Jira task",
      },
    } as TaskMetadata;

    const result = seedIssueContext(metadata);
    expect(result).not.toBeNull();
    expect(result).toContain("---");
    expect(result).toContain("Linear");
    expect(result).toContain("Jira");
  });
});
