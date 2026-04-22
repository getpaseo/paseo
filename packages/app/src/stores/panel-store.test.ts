import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => {
  const storage = new Map<string, string>();
  return {
    default: {
      getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        storage.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        storage.delete(key);
      }),
    },
  };
});

import {
  buildExplorerCheckoutKey,
  resolveExplorerTabForCheckout,
} from "@/stores/explorer-tab-memory";
import {
  selectIsAgentListOpen,
  selectIsFileExplorerOpen,
  selectPanelVisibility,
  usePanelStore,
  type PanelState,
} from "@/stores/panel-store";

function resetPanelStore() {
  usePanelStore.setState({
    mobileView: "agent",
    desktop: {
      agentListOpen: false,
      fileExplorerOpen: false,
      focusModeEnabled: false,
    },
    explorerTab: "changes",
    explorerTabByCheckout: {},
  });
}

function createPanelState(input: {
  mobileView: PanelState["mobileView"];
  agentListOpen: boolean;
  fileExplorerOpen: boolean;
}): PanelState {
  return {
    ...usePanelStore.getState(),
    mobileView: input.mobileView,
    desktop: {
      ...usePanelStore.getState().desktop,
      agentListOpen: input.agentListOpen,
      fileExplorerOpen: input.fileExplorerOpen,
    },
  };
}

beforeEach(() => {
  resetPanelStore();
});

describe("panel-store explorer tab resolution", () => {
  const serverId = "server-1";
  const cwd = "/tmp/repo";

  it("defaults to changes for git checkouts", () => {
    expect(
      resolveExplorerTabForCheckout({
        serverId,
        cwd,
        isGit: true,
        explorerTabByCheckout: {},
      }),
    ).toBe("changes");
  });

  it("defaults to files for non-git checkouts", () => {
    expect(
      resolveExplorerTabForCheckout({
        serverId,
        cwd,
        isGit: false,
        explorerTabByCheckout: {},
      }),
    ).toBe("files");
  });

  it("restores a stored files tab for git checkouts", () => {
    const key = buildExplorerCheckoutKey(serverId, cwd)!;
    expect(
      resolveExplorerTabForCheckout({
        serverId,
        cwd,
        isGit: true,
        explorerTabByCheckout: {
          [key]: "files",
        },
      }),
    ).toBe("files");
  });

  it("falls back to default when stored tab is invalid", () => {
    const key = buildExplorerCheckoutKey(serverId, cwd)!;
    expect(
      resolveExplorerTabForCheckout({
        serverId,
        cwd,
        isGit: true,
        explorerTabByCheckout: {
          [key]: "terminals" as any,
        },
      }),
    ).toBe("changes");
  });

  it("coerces stored changes to files for non-git checkouts", () => {
    const key = buildExplorerCheckoutKey(serverId, cwd)!;
    expect(
      resolveExplorerTabForCheckout({
        serverId,
        cwd,
        isGit: false,
        explorerTabByCheckout: {
          [key]: "changes",
        },
      }),
    ).toBe("files");
  });
});

describe("panel-store visibility selectors", () => {
  it("uses mobileView for compact layout visibility", () => {
    const state = createPanelState({
      mobileView: "file-explorer",
      agentListOpen: true,
      fileExplorerOpen: false,
    });

    expect(selectPanelVisibility(state, { isCompact: true })).toEqual({
      isAgentListOpen: false,
      isFileExplorerOpen: true,
    });
    expect(selectIsAgentListOpen(state, { isCompact: true })).toBe(false);
    expect(selectIsFileExplorerOpen(state, { isCompact: true })).toBe(true);
  });

  it("uses desktop flags for expanded layout visibility", () => {
    const state = createPanelState({
      mobileView: "file-explorer",
      agentListOpen: true,
      fileExplorerOpen: false,
    });

    expect(selectPanelVisibility(state, { isCompact: false })).toEqual({
      isAgentListOpen: true,
      isFileExplorerOpen: false,
    });
    expect(selectIsAgentListOpen(state, { isCompact: false })).toBe(true);
    expect(selectIsFileExplorerOpen(state, { isCompact: false })).toBe(false);
  });
});

describe("panel-store checkout-intent file explorer actions", () => {
  it("opens the compact explorer and resolves the tab from the explicit checkout", () => {
    const checkout = { serverId: "server-1", cwd: "/tmp/repo", isGit: true };
    const key = buildExplorerCheckoutKey(checkout.serverId, checkout.cwd)!;
    usePanelStore.setState({
      explorerTab: "changes",
      explorerTabByCheckout: { [key]: "files" },
    });

    usePanelStore.getState().openFileExplorerForCheckout({
      isCompact: true,
      checkout,
    });

    expect(usePanelStore.getState().mobileView).toBe("file-explorer");
    expect(usePanelStore.getState().desktop.fileExplorerOpen).toBe(false);
    expect(usePanelStore.getState().explorerTab).toBe("files");
  });

  it("opens the expanded explorer and resolves the tab from the explicit checkout", () => {
    const checkout = { serverId: "server-1", cwd: "/tmp/repo", isGit: true };
    const key = buildExplorerCheckoutKey(checkout.serverId, checkout.cwd)!;
    usePanelStore.setState({
      explorerTab: "changes",
      explorerTabByCheckout: { [key]: "files" },
    });

    usePanelStore.getState().openFileExplorerForCheckout({
      isCompact: false,
      checkout,
    });

    expect(usePanelStore.getState().mobileView).toBe("agent");
    expect(usePanelStore.getState().desktop.fileExplorerOpen).toBe(true);
    expect(usePanelStore.getState().explorerTab).toBe("files");
  });

  it("toggles the explorer closed without changing the active tab", () => {
    usePanelStore.setState({
      desktop: {
        agentListOpen: false,
        fileExplorerOpen: true,
        focusModeEnabled: false,
      },
      explorerTab: "files",
    });

    usePanelStore.getState().toggleFileExplorerForCheckout({
      isCompact: false,
      checkout: { serverId: "server-1", cwd: "/tmp/repo", isGit: true },
    });

    expect(usePanelStore.getState().desktop.fileExplorerOpen).toBe(false);
    expect(usePanelStore.getState().explorerTab).toBe("files");
  });

  it("coerces changes to files for a non-git checkout", () => {
    const checkout = { serverId: "server-1", cwd: "/tmp/repo", isGit: false };
    const key = buildExplorerCheckoutKey(checkout.serverId, checkout.cwd)!;
    usePanelStore.setState({
      explorerTab: "changes",
      explorerTabByCheckout: { [key]: "changes" },
    });

    usePanelStore.getState().openFileExplorerForCheckout({
      isCompact: false,
      checkout,
    });

    expect(usePanelStore.getState().explorerTab).toBe("files");
  });

  it("opens with the default files tab for an explicit non-git checkout with no stored tab", () => {
    usePanelStore.setState({ explorerTab: "changes", explorerTabByCheckout: {} });

    usePanelStore.getState().openFileExplorerForCheckout({
      isCompact: false,
      checkout: { serverId: "server-1", cwd: "/tmp/non-git", isGit: false },
    });

    expect(usePanelStore.getState().desktop.fileExplorerOpen).toBe(true);
    expect(usePanelStore.getState().explorerTab).toBe("files");
  });
});
