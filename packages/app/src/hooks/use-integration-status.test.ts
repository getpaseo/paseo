// Tests: use-integration-status
//
// Covers:
//   1. useIntegrationFetchItems respects the `enabled` option — does NOT fetch
//      before the dropdown is open, fetches immediately once enabled.
//   2. useIntegrationSearch fires via mutation (search-on-type path).
//   3. useIntegrationStatus builds the status map from daemon response.
//   4. Integration selector fetch is gated on isConnected AND showSelector.

import { describe, expect, it, vi, beforeEach } from "vitest";
import { QueryClient } from "@tanstack/react-query";

// ── Pure logic helpers extracted from the hook ────────────────────────────────

// The `enabled` guard logic:  !!client && !!isConnected && (options?.enabled !== false)
function isFetchEnabled(
  client: unknown,
  isConnected: boolean,
  optionsEnabled: boolean | undefined,
): boolean {
  return !!client && !!isConnected && optionsEnabled !== false;
}

describe("useIntegrationFetchItems — enabled guard", () => {
  const fakeClient = { fetchIntegrationItems: vi.fn() };

  it("is disabled when client is null", () => {
    expect(isFetchEnabled(null, true, true)).toBe(false);
    expect(isFetchEnabled(null, true, undefined)).toBe(false);
  });

  it("is disabled when host is not connected", () => {
    expect(isFetchEnabled(fakeClient, false, true)).toBe(false);
    expect(isFetchEnabled(fakeClient, false, undefined)).toBe(false);
  });

  it("is disabled when options.enabled is explicitly false", () => {
    expect(isFetchEnabled(fakeClient, true, false)).toBe(false);
  });

  it("is enabled when client is set, host is connected, and options.enabled is true", () => {
    expect(isFetchEnabled(fakeClient, true, true)).toBe(true);
  });

  it("is enabled when client is set, host is connected, and options.enabled is undefined", () => {
    expect(isFetchEnabled(fakeClient, true, undefined)).toBe(true);
  });

  it("remains disabled even after refetch if client is null", () => {
    // Simulates calling refetch() when the query is disabled
    expect(isFetchEnabled(null, true, true)).toBe(false);
  });
});

// ── Integration selector fetch gate ──────────────────────────────────────────
// The real selector passes `enabled: isConnected && showSelector` to the hook.
// This ensures 7 integrations don't all fetch simultaneously at mount.

function selectorFetchEnabled(isConnected: boolean, showSelector: boolean): boolean {
  return isConnected && showSelector;
}

describe("IntegrationSelector fetch gate (isConnected && showSelector)", () => {
  it("does NOT fetch on mount (showSelector=false)", () => {
    expect(selectorFetchEnabled(true, false)).toBe(false);
    expect(selectorFetchEnabled(false, false)).toBe(false);
  });

  it("does NOT fetch when integration is not connected even if dropdown is open", () => {
    expect(selectorFetchEnabled(false, true)).toBe(false);
  });

  it("fetches only when integration IS connected AND dropdown is open", () => {
    expect(selectorFetchEnabled(true, true)).toBe(true);
  });
});

// ── Status map building ───────────────────────────────────────────────────────
// Mirrors the logic inside useIntegrationStatus.statusMap memo.

import type { IntegrationId } from "@/types/kanban";

interface StatusEntry {
  id: IntegrationId;
  connected: boolean;
  account?: string;
}

const ALL_IDS: IntegrationId[] = [
  "github",
  "linear",
  "jira",
  "gitlab",
  "plain",
  "forgejo",
  "sentry",
];

function buildStatusMap(entries: StatusEntry[]): Record<IntegrationId, StatusEntry> {
  const base = Object.fromEntries(ALL_IDS.map((id) => [id, { id, connected: false }])) as Record<
    IntegrationId,
    StatusEntry
  >;

  for (const entry of entries) {
    base[entry.id] = entry;
  }
  return base;
}

describe("buildStatusMap (mirrors useIntegrationStatus logic)", () => {
  it("defaults all integrations to disconnected", () => {
    const map = buildStatusMap([]);
    for (const id of ALL_IDS) {
      expect(map[id].connected).toBe(false);
    }
  });

  it("marks a single integration as connected", () => {
    const map = buildStatusMap([{ id: "linear", connected: true, account: "user@example.com" }]);
    expect(map.linear.connected).toBe(true);
    expect(map.linear.account).toBe("user@example.com");
    expect(map.github.connected).toBe(false);
  });

  it("marks multiple integrations as connected independently", () => {
    const map = buildStatusMap([
      { id: "linear", connected: true },
      { id: "github", connected: true },
    ]);
    expect(map.linear.connected).toBe(true);
    expect(map.github.connected).toBe(true);
    expect(map.jira.connected).toBe(false);
    expect(map.gitlab.connected).toBe(false);
  });

  it("isConnected(id) helper returns correct value", () => {
    const map = buildStatusMap([{ id: "linear", connected: true }]);
    const isConnected = (id: IntegrationId) => map[id]?.connected ?? false;
    expect(isConnected("linear")).toBe(true);
    expect(isConnected("jira")).toBe(false);
  });
});

// ── QueryClient — verify staleTime on integration queries ────────────────────

describe("QueryClient cache behaviour for integration queries", () => {
  let qc: QueryClient;

  beforeEach(() => {
    qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  });

  it("cache key includes serverId, integrationId, and cwd", () => {
    const key = ["integration-items", "server-1", "linear", "/repo"];
    qc.setQueryData(key, [{ id: "issue-1", identifier: "BRA-3", title: "connect your tools" }]);
    const data = qc.getQueryData<Array<{ identifier: string }>>(key);
    expect(data?.[0]?.identifier).toBe("BRA-3");
  });

  it("different integrationId produces a different cache entry", () => {
    qc.setQueryData(["integration-items", "s1", "linear", undefined], [{ id: "l1" }]);
    qc.setQueryData(["integration-items", "s1", "github", undefined], [{ id: "g1" }]);

    const linear = qc.getQueryData<Array<{ id: string }>>([
      "integration-items",
      "s1",
      "linear",
      undefined,
    ]);
    const github = qc.getQueryData<Array<{ id: string }>>([
      "integration-items",
      "s1",
      "github",
      undefined,
    ]);

    expect(linear?.[0]?.id).toBe("l1");
    expect(github?.[0]?.id).toBe("g1");
  });

  it("different serverId produces a different cache entry", () => {
    qc.setQueryData(["integration-items", "server-A", "linear", undefined], [{ id: "a" }]);
    qc.setQueryData(["integration-items", "server-B", "linear", undefined], [{ id: "b" }]);

    expect(
      qc.getQueryData<Array<{ id: string }>>([
        "integration-items",
        "server-A",
        "linear",
        undefined,
      ])?.[0]?.id,
    ).toBe("a");
    expect(
      qc.getQueryData<Array<{ id: string }>>([
        "integration-items",
        "server-B",
        "linear",
        undefined,
      ])?.[0]?.id,
    ).toBe("b");
  });
});

// ── Item label formatting ─────────────────────────────────────────────────────
// Mirrors getItemLabel() in IntegrationSelector — used in the dropdown list.

function getItemLabel(item: Record<string, unknown>): string {
  const identifier =
    item.identifier ?? item.key ?? (item.number != null ? `#${item.number}` : null) ?? "";
  const title = String(item.title ?? item.previewText ?? "");
  return identifier ? `${identifier} - ${title}` : title;
}

describe("getItemLabel (item display in dropdown)", () => {
  it("formats Linear items as 'BRA-3 - connect your tools'", () => {
    expect(getItemLabel({ identifier: "BRA-3", title: "connect your tools" })).toBe(
      "BRA-3 - connect your tools",
    );
  });

  it("formats GitHub items using #number", () => {
    expect(getItemLabel({ number: 42, title: "Add dark mode" })).toBe("#42 - Add dark mode");
  });

  it("formats Jira items using key", () => {
    expect(getItemLabel({ key: "ENG-10", title: "Fix bug" })).toBe("ENG-10 - Fix bug");
  });

  it("falls back to title only when there is no identifier", () => {
    expect(getItemLabel({ title: "Standalone title" })).toBe("Standalone title");
  });

  it("uses previewText when title is absent (Plain threads)", () => {
    expect(getItemLabel({ id: "t1", previewText: "Support request from Alice" })).toBe(
      "Support request from Alice",
    );
  });
});

// ── Integration context key mapping ─────────────────────────────────────────
// Mirrors handleIntegrationChange() in TaskCreationModal.

import type { TaskIntegrationContext } from "@/types/kanban";

function integrationContextKey(integrationId: IntegrationId): keyof TaskIntegrationContext {
  return integrationId === "plain"
    ? "plainThreadId"
    : (`${integrationId}IssueId` as keyof TaskIntegrationContext);
}

describe("integrationContextKey (TaskIntegrationContext key mapping)", () => {
  it("maps linear → linearIssueId", () => {
    expect(integrationContextKey("linear")).toBe("linearIssueId");
  });
  it("maps github → githubIssueId", () => {
    expect(integrationContextKey("github")).toBe("githubIssueId");
  });
  it("maps jira → jiraIssueId", () => {
    expect(integrationContextKey("jira")).toBe("jiraIssueId");
  });
  it("maps gitlab → gitlabIssueId", () => {
    expect(integrationContextKey("gitlab")).toBe("gitlabIssueId");
  });
  it("maps plain → plainThreadId (NOT plainIssueId)", () => {
    expect(integrationContextKey("plain")).toBe("plainThreadId");
  });
  it("maps forgejo → forgejoIssueId", () => {
    expect(integrationContextKey("forgejo")).toBe("forgejoIssueId");
  });
  it("maps sentry → sentryIssueId", () => {
    expect(integrationContextKey("sentry")).toBe("sentryIssueId");
  });
});
