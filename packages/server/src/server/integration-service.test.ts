import { describe, expect, test, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Mock hubcode-home to use a temp directory
const tempDir = path.join(os.tmpdir(), `hubcode-integration-test-${Date.now()}`);
vi.mock("./hubcode-home.js", () => ({
  resolveHubcodeHome: () => tempDir,
}));

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import {
  listIntegrationStatus,
  connectIntegration,
  disconnectIntegration,
  searchIntegrationItems,
  fetchIntegrationItems,
} from "./integration-service.js";

function mockFetchResponse(ok: boolean, data: unknown, status = 200) {
  mockFetch.mockResolvedValueOnce({
    ok,
    status,
    json: () => Promise.resolve(data),
  });
}

describe("integration-service", () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(tempDir, "integrations"), { recursive: true });
    mockFetch.mockReset();
  });

  afterEach(() => {
    // Clean up temp dir
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("listIntegrationStatus", () => {
    test("returns all integrations as disconnected by default", async () => {
      const status = await listIntegrationStatus();
      expect(status).toHaveLength(7);
      for (const entry of status) {
        expect(entry.connected).toBe(false);
      }
    });

    test("returns connected status after connecting", async () => {
      // Write a fake stored integration
      const storePath = path.join(tempDir, "integrations", "linear.json");
      fs.writeFileSync(
        storePath,
        JSON.stringify({
          credentials: { token: "test-token" },
          account: "Test Org",
          connectedAt: new Date().toISOString(),
        }),
      );

      const status = await listIntegrationStatus();
      const linear = status.find((s) => s.id === "linear");
      expect(linear?.connected).toBe(true);
      expect(linear?.account).toBe("Test Org");
    });
  });

  describe("connectIntegration", () => {
    test("validates and stores Linear credentials", async () => {
      mockFetchResponse(true, {
        data: {
          viewer: {
            id: "usr-1",
            name: "Test User",
            email: "test@example.com",
            organization: { name: "Test Org" },
          },
        },
      });

      const result = await connectIntegration("linear", { token: "lin_test_123" });
      expect(result.success).toBe(true);
      expect(result.account).toBe("Test Org");

      // Verify file was written
      const stored = JSON.parse(
        fs.readFileSync(path.join(tempDir, "integrations", "linear.json"), "utf-8"),
      );
      expect(stored.credentials.token).toBe("lin_test_123");
    });

    test("validates and stores GitHub credentials", async () => {
      mockFetchResponse(true, { login: "octocat" });

      const result = await connectIntegration("github", { token: "ghp_test123" });
      expect(result.success).toBe(true);
      expect(result.account).toBe("octocat");
    });

    test("validates and stores Jira credentials", async () => {
      mockFetchResponse(true, { displayName: "John Doe" });

      const result = await connectIntegration("jira", {
        site: "https://myorg.atlassian.net",
        email: "john@example.com",
        token: "jira-token",
      });
      expect(result.success).toBe(true);
      expect(result.account).toBe("John Doe");
    });

    test("validates and stores GitLab credentials", async () => {
      mockFetchResponse(true, { username: "gitlab-user" });

      const result = await connectIntegration("gitlab", {
        instanceUrl: "https://gitlab.com",
        token: "glpat-test123",
      });
      expect(result.success).toBe(true);
      expect(result.account).toBe("gitlab-user");
    });

    test("validates and stores Plain credentials", async () => {
      mockFetchResponse(true, {
        data: { myWorkspace: { id: "ws-1", publicName: "My Workspace" } },
      });

      const result = await connectIntegration("plain", { token: "plain-test-key" });
      expect(result.success).toBe(true);
      expect(result.account).toBe("My Workspace");
    });

    test("validates and stores Forgejo credentials", async () => {
      mockFetchResponse(true, { login: "forgejo-user" });

      const result = await connectIntegration("forgejo", {
        instanceUrl: "https://forgejo.example.com",
        token: "forgejo-token",
      });
      expect(result.success).toBe(true);
      expect(result.account).toBe("forgejo-user");
    });

    test("validates and stores Sentry credentials", async () => {
      mockFetchResponse(true, [{ slug: "my-org", name: "My Organization" }]);

      const result = await connectIntegration("sentry", { token: "sntrys_test123" });
      expect(result.success).toBe(true);
      expect(result.account).toBe("My Organization");
    });

    test("returns error for invalid credentials", async () => {
      mockFetchResponse(false, {}, 401);

      const result = await connectIntegration("github", { token: "bad-token" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("401");
    });

    test("returns error for missing required credentials", async () => {
      const result = await connectIntegration("jira", { token: "only-token" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("required");
    });

    test("returns error for unknown integration", async () => {
      const result = await connectIntegration("nonexistent", { token: "test" });
      expect(result.success).toBe(false);
      expect(result.error).toContain("Unknown integration");
    });
  });

  describe("disconnectIntegration", () => {
    test("removes stored credentials", async () => {
      // First connect
      const storePath = path.join(tempDir, "integrations", "linear.json");
      fs.writeFileSync(
        storePath,
        JSON.stringify({ credentials: { token: "test" }, connectedAt: new Date().toISOString() }),
      );

      const result = await disconnectIntegration("linear");
      expect(result.success).toBe(true);

      // Verify file is deleted
      expect(fs.existsSync(storePath)).toBe(false);
    });

    test("succeeds even if not connected", async () => {
      const result = await disconnectIntegration("github");
      expect(result.success).toBe(true);
    });
  });

  describe("searchIntegrationItems", () => {
    test("returns error when not connected", async () => {
      const result = await searchIntegrationItems("linear", "test query");
      expect(result.error).toContain("not connected");
      expect(result.items).toEqual([]);
    });

    test("searches GitHub issues when connected", async () => {
      // Store credentials
      const storePath = path.join(tempDir, "integrations", "github.json");
      fs.writeFileSync(
        storePath,
        JSON.stringify({
          credentials: { token: "ghp_test" },
          account: "octocat",
          connectedAt: new Date().toISOString(),
        }),
      );

      mockFetchResponse(true, {
        items: [
          {
            id: 1,
            number: 42,
            title: "Fix bug",
            body: "Details",
            state: "open",
            html_url: "https://github.com/org/repo/issues/42",
            repository_url: "https://api.github.com/repos/org/repo",
          },
        ],
      });

      const result = await searchIntegrationItems("github", "bug");
      expect(result.items).toHaveLength(1);
      expect(result.items[0].number).toBe(42);
      expect(result.items[0].title).toBe("Fix bug");
    });

    test("searches Linear issues when connected", async () => {
      const storePath = path.join(tempDir, "integrations", "linear.json");
      fs.writeFileSync(
        storePath,
        JSON.stringify({
          credentials: { token: "lin_test" },
          account: "Test Org",
          connectedAt: new Date().toISOString(),
        }),
      );

      mockFetchResponse(true, {
        data: {
          searchIssues: {
            nodes: [
              {
                id: "iss-1",
                identifier: "LIN-42",
                title: "Implement feature",
                description: "Desc",
                url: "https://linear.app/...",
                state: { name: "In Progress" },
                assignee: { name: "John" },
                team: { name: "Backend" },
                project: { name: "Auth" },
              },
            ],
          },
        },
      });

      const result = await searchIntegrationItems("linear", "feature");
      expect(result.items).toHaveLength(1);
      expect(result.items[0].identifier).toBe("LIN-42");
    });
  });

  describe("fetchIntegrationItems", () => {
    test("returns error when not connected", async () => {
      const result = await fetchIntegrationItems("github");
      expect(result.error).toContain("not connected");
    });

    test("fetches Linear issues when connected", async () => {
      const storePath = path.join(tempDir, "integrations", "linear.json");
      fs.writeFileSync(
        storePath,
        JSON.stringify({
          credentials: { token: "lin_test" },
          account: "Test Org",
          connectedAt: new Date().toISOString(),
        }),
      );

      mockFetchResponse(true, {
        data: {
          viewer: {
            assignedIssues: {
              nodes: [
                {
                  id: "iss-1",
                  identifier: "LIN-1",
                  title: "Task 1",
                  url: "https://linear.app/1",
                  state: { name: "Todo" },
                  assignee: null,
                  team: { name: "Frontend" },
                  project: null,
                },
                {
                  id: "iss-2",
                  identifier: "LIN-2",
                  title: "Task 2",
                  url: "https://linear.app/2",
                  state: { name: "In Progress" },
                  assignee: { name: "Dev" },
                  team: { name: "Frontend" },
                  project: null,
                },
              ],
            },
          },
        },
      });

      const result = await fetchIntegrationItems("linear");
      expect(result.items).toHaveLength(2);
      expect(result.items[0].identifier).toBe("LIN-1");
      expect(result.items[1].identifier).toBe("LIN-2");
    });
  });
});
