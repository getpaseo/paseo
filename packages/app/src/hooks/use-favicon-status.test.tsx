/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { useFaviconStatus } from "./use-favicon-status";

vi.mock("@/constants/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/constants/platform")>()),
  isNative: false,
}));
vi.mock("@/desktop/host", () => ({ getDesktopHost: () => undefined }));
const runtime = vi.hoisted(() => ({
  acquireDirectoryDemand: () => () => undefined,
  subscribeAll: () => () => undefined,
  getVersion: () => 0,
  getSnapshot: () => ({ agentDirectoryStatus: "ready" as const }),
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => [],
  getHostRuntimeStore: () => runtime,
}));

const SERVER_ID = "srv_a";

function agent(input: { id: string; status?: Agent["status"] }): Agent {
  const updatedAt = new Date("2026-01-01T00:00:00.000Z");
  return {
    serverId: SERVER_ID,
    id: input.id,
    provider: "codex",
    status: input.status ?? "idle",
    turn: { phase: "idle", cancellationRequestId: null },
    createdAt: updatedAt,
    updatedAt,
    lastUserMessageAt: null,
    lastActivityAt: updatedAt,
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: input.id,
    cwd: "/repo",
    workspaceId: "workspace-1",
    model: null,
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    archivedAt: null,
    parentAgentId: null,
    background: false,
    labels: {},
  };
}

function publish(agents: Agent[]): void {
  useSessionStore
    .getState()
    .setAgents(SERVER_ID, new Map(agents.map((entry) => [entry.id, entry])));
}

function faviconHref(): string | null {
  return document.querySelector<HTMLLinkElement>('link[rel="icon"]')?.getAttribute("href") ?? null;
}

describe("useFaviconStatus", () => {
  let root: Root | null = null;
  let renders = 0;

  function Probe() {
    renders += 1;
    useFaviconStatus();
    return null;
  }

  beforeAll(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: () => ({
        addEventListener: () => {},
        addListener: () => {},
        dispatchEvent: () => false,
        matches: false,
        media: "",
        onchange: null,
        removeEventListener: () => {},
        removeListener: () => {},
      }),
    });
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    renders = 0;
    vi.restoreAllMocks();
  });

  function mount(): void {
    useSessionStore.getState().initializeSession(SERVER_ID, null as never);
    const container = document.createElement("div");
    root = createRoot(container);
    act(() => root?.render(<Probe />));
  }

  it("does not re-render when an agent update leaves the status alone", () => {
    mount();
    publish([agent({ id: "a" }), agent({ id: "b" })]);
    const afterFirstStatus = renders;

    // An update that changes nothing the favicon reads: no title, no new status.
    act(() => publish([agent({ id: "a" }), agent({ id: "b" })]));
    act(() => publish([agent({ id: "a" }), agent({ id: "b" }), agent({ id: "c" })]));

    expect(renders).toBe(afterFirstStatus);
  });

  it("follows a running agent and drops back when it stops", () => {
    mount();
    publish([agent({ id: "a" })]);
    const idleHref = faviconHref();
    expect(idleHref).toBeTruthy();
    expect(idleHref).not.toContain("running");

    act(() => publish([agent({ id: "a", status: "running" })]));
    expect(faviconHref()).toContain("running");

    act(() => publish([agent({ id: "a" })]));
    expect(faviconHref()).toBe(idleHref);
  });
});
