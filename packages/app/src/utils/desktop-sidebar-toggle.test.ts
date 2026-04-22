import { describe, expect, it, vi } from "vitest";

import { toggleDesktopSidebarsWithCheckoutIntent } from "./desktop-sidebar-toggle";

describe("toggleDesktopSidebarsWithCheckoutIntent", () => {
  it("closes both sidebars when either desktop sidebar is open", () => {
    const openAgentList = vi.fn();
    const closeAgentList = vi.fn();
    const closeFileExplorer = vi.fn();
    const toggleFocusedFileExplorer = vi.fn(() => true);

    const handled = toggleDesktopSidebarsWithCheckoutIntent({
      isAgentListOpen: true,
      isFileExplorerOpen: false,
      openAgentList,
      closeAgentList,
      closeFileExplorer,
      toggleFocusedFileExplorer,
    });

    expect(handled).toBe(true);
    expect(closeAgentList).toHaveBeenCalledTimes(1);
    expect(closeFileExplorer).toHaveBeenCalledTimes(1);
    expect(openAgentList).not.toHaveBeenCalled();
    expect(toggleFocusedFileExplorer).not.toHaveBeenCalled();
  });

  it("opens the right sidebar only through the focused checkout-aware handler", () => {
    const openAgentList = vi.fn();
    const closeAgentList = vi.fn();
    const closeFileExplorer = vi.fn();
    const toggleFocusedFileExplorer = vi.fn(() => false);

    const handled = toggleDesktopSidebarsWithCheckoutIntent({
      isAgentListOpen: false,
      isFileExplorerOpen: false,
      openAgentList,
      closeAgentList,
      closeFileExplorer,
      toggleFocusedFileExplorer,
    });

    expect(handled).toBe(true);
    expect(openAgentList).toHaveBeenCalledTimes(1);
    expect(toggleFocusedFileExplorer).toHaveBeenCalledTimes(1);
    expect(closeAgentList).not.toHaveBeenCalled();
    expect(closeFileExplorer).not.toHaveBeenCalled();
  });
});
