/** @vitest-environment jsdom */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { LatestTurnDiff } from "./latest-turn-diff";

const { observeDiff } = vi.hoisted(() => ({
  observeDiff: vi.fn(() => ({ subscribe: () => () => {}, release: async () => {} })),
}));
const client = { observeDiff };
vi.mock("@/runtime/host-runtime", () => ({ useHostRuntimeClient: () => client }));
vi.mock("@/git/diff-document", () => ({ DiffDocument: () => null }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const serverId = "host";
const workspaceId = "workspace";
const now = new Date("2026-03-01T12:00:00Z");
const preferences = {
  layout: "unified",
  wrapLines: false,
  codeFontSize: 14,
  monoFontFamily: "mono",
} as const;

function createAgent(id: string): Agent {
  return {
    id,
    serverId,
    workspaceId,
    provider: "codex",
    status: "idle",
    title: id,
    cwd: "/repo",
    model: null,
    turn: { phase: "idle", cancellationRequestId: null },
    latestTurnChanges: { turnId: "turn", before: `${id}-before`, after: `${id}-after` },
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
    lastUserMessageAt: null,
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: false,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    parentAgentId: null,
    labels: {},
  };
}

afterEach(() => {
  cleanup();
  useSessionStore.getState().clearSession(serverId);
  observeDiff.mockClear();
});

test("keeps an explicit Latest turn target through archive and deletion", () => {
  const store = useSessionStore.getState();
  const selected = createAgent("Selected agent");
  const other = createAgent("Other agent");
  store.initializeSession(serverId, null);
  store.setAgents(
    serverId,
    new Map([
      [selected.id, selected],
      [other.id, other],
    ]),
  );
  render(
    <LatestTurnDiff
      serverId={serverId}
      workspaceId={workspaceId}
      defaultAgentId={selected.id}
      enabled
      ignoreWhitespace={false}
      displayPreferences={preferences}
    />,
  );
  expect(observeDiff).toHaveBeenCalledExactlyOnceWith({
    cwd: selected.cwd,
    base: { kind: "rev", rev: selected.latestTurnChanges!.before },
    head: { kind: "rev", rev: selected.latestTurnChanges!.after },
    ignoreWhitespace: false,
  });

  act(() => {
    store.setAgentDetails(serverId, new Map([[selected.id, { ...selected, archivedAt: now }]]));
    store.setAgents(serverId, new Map([[other.id, other]]));
  });
  expect(screen.getByText(selected.title!)).toBeInstanceOf(HTMLElement);
  expect(observeDiff).toHaveBeenCalledTimes(1);

  act(() => store.setAgentDetails(serverId, new Map()));
  expect(screen.getByText("workspace.git.diff.latestTurnUnavailable")).toBeInstanceOf(HTMLElement);
  expect(screen.getByTestId("latest-turn-agent-picker")).toBeInstanceOf(HTMLElement);
  expect(observeDiff).toHaveBeenCalledTimes(1);
});
