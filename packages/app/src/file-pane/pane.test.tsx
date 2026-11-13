// @vitest-environment jsdom
/* eslint-disable react-perf/jsx-no-new-object-as-prop */
import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FilePane } from "./pane";

const state = vi.hoisted(() => ({
  connected: true,
  snapshot: { status: "ready", kind: "binary", size: 12 } as {
    status: string;
    kind?: string;
    size?: number;
  },
  panel: null as { id: string } | null,
  download: vi.fn(),
  scope: "",
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: (
    selector: (value: { sessions: Record<string, { client: object | null }> }) => unknown,
  ) => selector({ sessions: { server: { client: state.connected ? {} : null } } }),
}));
vi.mock("@/hooks/use-file-download", () => ({
  useFileDownload: ({ workspaceRoot }: { workspaceRoot: string }) => {
    state.scope = workspaceRoot;
    return state.download;
  },
}));
vi.mock("@/file-panels/file", () => ({
  useFileHandle: () => ({ retry: vi.fn(), file: {} }),
  useFileHandleSnapshot: () => state.snapshot,
}));
vi.mock("@/file-panels", () => ({
  useFilePanelChoice: () => ({ panel: state.panel, choice: {} }),
  FilePanelPicker: () => null,
  FilePanelView: () => <div>registered panel</div>,
}));
vi.mock("@/components/retained-panel", () => ({ useRetainedPanelActive: () => true }));
vi.mock("@/hooks/use-app-visible", () => ({ useAppActivelyVisible: () => true }));
vi.mock("@/panels/panel-instance-attributes", () => ({
  usePublishPanelInstanceAttributes: () => {},
}));
vi.mock("@/panels/pane-context", () => ({
  usePaneContext: () => ({ state: {}, setCurrentTabState: vi.fn() }),
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onPress }: { children: React.ReactNode; onPress: () => void }) => (
    <button type="button" onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("@/file-panels/loading", () => ({ FilePanelLoading: () => <div>loading</div> }));

afterEach(() => {
  cleanup();
  state.connected = true;
  state.snapshot = { status: "ready", kind: "binary", size: 12 };
  state.panel = null;
  state.download.mockClear();
});
const show = (path: string) =>
  render(
    <FilePane
      serverId="server"
      workspaceRoot="/workspace"
      location={{ path }}
      navigationRevision={0}
    />,
  );
describe("unsupported file preview", () => {
  it("downloads the displayed external file with its resolved scope and Unicode name", () => {
    show("/outside/报告.xlsx");
    fireEvent.click(screen.getByRole("button", { name: "workspace.fileActions.download" }));
    expect(state.scope).toBe("/");
    expect(state.download).toHaveBeenCalledWith({
      fileName: "报告.xlsx",
      path: "/outside/报告.xlsx",
    });
  });
  it("uses the Windows basename and resolved drive", () => {
    show("C:\\outside\\报告.xlsx");
    fireEvent.click(screen.getByRole("button", { name: "workspace.fileActions.download" }));
    expect(state.scope).toBe("C:/");
    expect(state.download).toHaveBeenCalledWith({
      fileName: "报告.xlsx",
      path: "C:\\outside\\报告.xlsx",
    });
  });
  it("does not offer the fallback for registered panels, missing files, or disconnected hosts", () => {
    state.panel = { id: "panel" };
    const rendered = show("file.xlsx");
    expect(screen.queryByRole("button", { name: "workspace.fileActions.download" })).toBeNull();
    state.panel = null;
    state.snapshot = { status: "missing" };
    rendered.rerender(
      <FilePane
        serverId="server"
        workspaceRoot="/workspace"
        location={{ path: "file.xlsx" }}
        navigationRevision={0}
      />,
    );
    expect(screen.queryByRole("button", { name: "workspace.fileActions.download" })).toBeNull();
    state.connected = false;
    rendered.rerender(
      <FilePane
        serverId="server"
        workspaceRoot="/workspace"
        location={{ path: "file.xlsx" }}
        navigationRevision={0}
      />,
    );
    expect(screen.queryByRole("button", { name: "workspace.fileActions.download" })).toBeNull();
  });
});
