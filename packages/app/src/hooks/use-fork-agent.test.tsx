/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act } from "@testing-library/react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  buildAgentForkContextMock,
  navigateToWorkspaceMock,
  routerPushMock,
  setWorkspaceAttachmentsMock,
  setDraftSetupMock,
  sessionStateRef,
} = vi.hoisted(() => ({
  buildAgentForkContextMock: vi.fn(),
  navigateToWorkspaceMock: vi.fn(),
  routerPushMock: vi.fn(),
  setWorkspaceAttachmentsMock: vi.fn(),
  setDraftSetupMock: vi.fn(),
  sessionStateRef: { current: null as unknown },
}));

vi.mock("expo-router", () => ({
  useRouter: () => ({ push: routerPushMock }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (state: unknown) => unknown) => selector(sessionStateRef.current),
}));

vi.mock("@/stores/navigation-active-workspace-store", () => ({
  navigateToWorkspace: navigateToWorkspaceMock,
}));

vi.mock("@/stores/draft-keys", () => ({
  generateDraftId: () => "draft-1",
}));

vi.mock("@/attachments/workspace-attachments-store", () => ({
  buildDraftWorkspaceAttachmentScopeKey: (draftId: string) => `draft:${draftId}`,
  useWorkspaceAttachmentsStore: {
    getState: () => ({ setWorkspaceAttachments: setWorkspaceAttachmentsMock }),
  },
}));

vi.mock("@/stores/workspace-draft-submission-store", () => ({
  useWorkspaceDraftSubmissionStore: {
    getState: () => ({ setDraftSetup: setDraftSetupMock }),
  },
}));

import { useForkAgent, type ForkAgentRequest, type ForkAgentSource } from "@/hooks/use-fork-agent";

const SERVER_ID = "server-1";
const AGENT_ID = "agent-1";

const agent = {
  provider: "claude",
  cwd: "/repo",
  currentModeId: null,
  model: null,
  thinkingOptionId: null,
  runtimeInfo: null,
  features: [],
  projectPlacement: null,
} as unknown as ForkAgentSource;

function setSessionState(options: { supportsFork: boolean }) {
  sessionStateRef.current = {
    sessions: {
      [SERVER_ID]: {
        client: { buildAgentForkContext: buildAgentForkContextMock },
        serverInfo: { features: { agentForkContext: options.supportsFork } },
      },
    },
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

/** Mounts the hook and returns its fork driver. */
async function mountForkAgent(input: { readOnly?: boolean } = {}) {
  let fork: ((request: ForkAgentRequest) => Promise<void>) | null = null;
  function Probe() {
    fork = useForkAgent({ serverId: SERVER_ID, readOnly: input.readOnly });
    return null;
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<Probe />);
  });
  if (!fork) {
    throw new Error("useForkAgent did not return a fork driver");
  }
  return fork as (request: ForkAgentRequest) => Promise<void>;
}

beforeEach(() => {
  vi.clearAllMocks();
  setSessionState({ supportsFork: true });
  buildAgentForkContextMock.mockResolvedValue({
    attachment: { type: "text", mimeType: "text/plain", text: "history" },
    boundaryMessageId: null,
    boundaryCursor: null,
    itemCount: 7,
  });
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe("useForkAgent boundary handling", () => {
  it("omits the boundary entirely when the caller supplies none (in-flight turn fork)", async () => {
    const fork = await mountForkAgent();

    await act(async () => {
      await fork({ agentId: AGENT_ID, agent, workspaceId: "workspace-1", target: "tab" });
    });

    expect(buildAgentForkContextMock).toHaveBeenCalledTimes(1);
    // The whole point of the running-turn fork: no boundary reaches the RPC, so
    // the daemon projects the full timeline including the streaming response.
    expect(buildAgentForkContextMock.mock.calls[0]).toEqual([AGENT_ID, undefined]);
    expect(navigateToWorkspaceMock).toHaveBeenCalledTimes(1);
    expect(navigateToWorkspaceMock.mock.calls[0]?.[0]).toMatchObject({
      serverId: SERVER_ID,
      workspaceId: "workspace-1",
      target: { kind: "draft", draftId: "draft-1" },
    });
  });

  it("forwards the pinned boundary when the caller supplies one (completed turn fork)", async () => {
    const fork = await mountForkAgent();
    const boundary = {
      boundaryMessageId: "message-9",
      boundaryCursor: { epoch: "epoch-1", seq: 9 },
    };

    await act(async () => {
      await fork({ agentId: AGENT_ID, agent, workspaceId: "workspace-1", target: "tab", boundary });
    });

    expect(buildAgentForkContextMock.mock.calls[0]).toEqual([AGENT_ID, boundary]);
  });

  it("never reaches the RPC on a read-only surface", async () => {
    const fork = await mountForkAgent({ readOnly: true });

    await act(async () => {
      await fork({ agentId: AGENT_ID, agent, workspaceId: "workspace-1", target: "tab" });
    });

    expect(buildAgentForkContextMock).not.toHaveBeenCalled();
    expect(navigateToWorkspaceMock).not.toHaveBeenCalled();
  });

  it("never reaches the RPC when the host lacks agentForkContext", async () => {
    setSessionState({ supportsFork: false });
    const fork = await mountForkAgent();

    await act(async () => {
      await fork({ agentId: AGENT_ID, agent, workspaceId: "workspace-1", target: "tab" });
    });

    expect(buildAgentForkContextMock).not.toHaveBeenCalled();
  });
});
