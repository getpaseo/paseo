import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  openTabMock,
  fetchAgentTimelineMock,
  listEvidenceRunsMock,
  getEvidenceArtifactMock,
  stableMockClient,
} = vi.hoisted(() => {
  const listEvidenceRuns = vi.fn();
  const getEvidenceArtifact = vi.fn();
  return {
    openTabMock: vi.fn(),
    fetchAgentTimelineMock: vi.fn(),
    listEvidenceRunsMock: listEvidenceRuns,
    getEvidenceArtifactMock: getEvidenceArtifact,
    stableMockClient: {
      listEvidenceRuns,
      getEvidenceArtifact,
    },
  };
});

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => stableMockClient,
  getHostRuntimeStore: () => ({ fetchAgentTimeline: fetchAgentTimelineMock }),
}));

vi.mock("@/panels/pane-context", () => ({
  usePaneContext: () => ({
    serverId: "srv_1",
    workspaceId: "wks_1",
    tabId: "tab_1",
    openTab: openTabMock,
  }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/components/icons/ui-icons", () => {
  const createIcon = (name: string) => () => React.createElement("span", { "data-icon": name });
  return {
    Camera: createIcon("Camera"),
    ChevronDown: createIcon("ChevronDown"),
    ChevronRight: createIcon("ChevronRight"),
    FileText: createIcon("FileText"),
    MessageSquare: createIcon("MessageSquare"),
    RefreshCw: createIcon("RefreshCw"),
  };
});

vi.mock("@/components/attachment-lightbox", () => ({
  AttachmentLightbox: (props: { source: { uri: string } | null }) =>
    props.source
      ? React.createElement("div", {
          "data-testid": "evidence-lightbox",
          "data-uri": props.source.uri,
        })
      : null,
}));

vi.mock("react-native", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("react-native");
  return { ...actual };
});

import { EvidenceContent } from "./evidence-content";

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  vi.stubGlobal("Node", dom.window.Node);
  vi.stubGlobal("navigator", dom.window.navigator);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.clearAllMocks();
});

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount();
    });
  }
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

function render() {
  act(() => {
    root?.render(React.createElement(EvidenceContent, { serverId: "srv_1", workspaceId: "wks_1" }));
  });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

function queryByTestId(testID: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testID}"]`);
}

function textContent(): string {
  return document.body.textContent ?? "";
}

const RUN = {
  runId: "evr_01",
  workspaceId: "wks_1",
  recipe: "verify-report",
  seq: 2,
  startedAt: "2026-09-17T10:00:00.000Z",
  status: "pass" as const,
  agentId: "agent_7",
  artifactCount: 1,
  artifacts: [
    {
      name: "screenshot-report",
      kind: "screenshot",
      contentType: "image/png",
      bytes: 2048,
      sha256: "deadbeef",
      capturedAt: "2026-09-17T10:00:30.000Z",
      timelineCursor: { epoch: "e1", seq: 41 },
    },
  ],
};

describe("EvidenceContent", () => {
  it("shows the empty state when no runs exist", async () => {
    listEvidenceRunsMock.mockResolvedValue({ runs: [], error: null });
    render();
    await flush();
    expect(listEvidenceRunsMock).toHaveBeenCalledWith("wks_1");
    expect(textContent()).toContain("panels.evidence.emptyTitle");
  });

  it("retries after a load failure", async () => {
    listEvidenceRunsMock.mockRejectedValueOnce(new Error("offline"));
    listEvidenceRunsMock.mockResolvedValueOnce({ runs: [], error: null });
    render();
    await flush();
    expect(queryByTestId("evidence-retry")).not.toBeNull();
    act(() => {
      queryByTestId("evidence-retry")?.dispatchEvent(
        new window.MouseEvent("click", { bubbles: true }),
      );
    });
    await flush();
    expect(listEvidenceRunsMock).toHaveBeenCalledTimes(2);
  });

  it("expands a run and opens a screenshot in the lightbox", async () => {
    listEvidenceRunsMock.mockResolvedValue({ runs: [RUN], error: null });
    getEvidenceArtifactMock.mockResolvedValue({
      artifact: RUN.artifacts[0],
      dataBase64: "iVBORw0KGgo=",
      error: null,
    });
    render();
    await flush();
    act(() => {
      queryByTestId("evidence-run-evr_01")?.dispatchEvent(
        new window.MouseEvent("click", { bubbles: true }),
      );
    });
    expect(textContent()).toContain("screenshot-report");
    act(() => {
      queryByTestId("evidence-open-evr_01-screenshot-report")?.dispatchEvent(
        new window.MouseEvent("click", { bubbles: true }),
      );
    });
    await flush();
    expect(getEvidenceArtifactMock).toHaveBeenCalledWith("wks_1", "evr_01", "screenshot-report");
    expect(queryByTestId("evidence-lightbox")?.getAttribute("data-uri")).toBe(
      "data:image/png;base64,iVBORw0KGgo=",
    );
  });

  it("anchors an artifact to its chat position", async () => {
    listEvidenceRunsMock.mockResolvedValue({ runs: [RUN], error: null });
    render();
    await flush();
    act(() => {
      queryByTestId("evidence-run-evr_01")?.dispatchEvent(
        new window.MouseEvent("click", { bubbles: true }),
      );
    });
    act(() => {
      queryByTestId("evidence-anchor-evr_01-screenshot-report")?.dispatchEvent(
        new window.MouseEvent("click", { bubbles: true }),
      );
    });
    await flush();
    expect(openTabMock).toHaveBeenCalledWith({ kind: "agent", agentId: "agent_7" });
    expect(fetchAgentTimelineMock).toHaveBeenCalledWith(
      "srv_1",
      "agent_7",
      expect.objectContaining({ direction: "before" }),
    );
  });
});
