import { describe, expect, it, vi } from "vitest";

import { toggleDesktopSidebarsWithCheckoutIntent } from "./desktop-sidebar-toggle";

function harness(state: { isAgentListOpen: boolean; isExplorerOpen: boolean }) {
  const openAgentList = vi.fn();
  const closeAgentList = vi.fn();
  const toggleExplorer = vi.fn();
  const handled = toggleDesktopSidebarsWithCheckoutIntent({
    ...state,
    openAgentList,
    closeAgentList,
    toggleExplorer,
  });
  return { handled, openAgentList, closeAgentList, toggleExplorer };
}

describe("toggleDesktopSidebarsWithCheckoutIntent", () => {
  it("closes only what is open when either side is showing", () => {
    const result = harness({ isAgentListOpen: true, isExplorerOpen: false });

    expect(result.handled).toBe(true);
    expect(result.closeAgentList).toHaveBeenCalledTimes(1);
    expect(result.openAgentList).not.toHaveBeenCalled();
    // The explorer is already closed; toggling it would reopen it.
    expect(result.toggleExplorer).not.toHaveBeenCalled();
  });

  it("closes the explorer when it is the only side showing", () => {
    const result = harness({ isAgentListOpen: false, isExplorerOpen: true });

    expect(result.toggleExplorer).toHaveBeenCalledTimes(1);
    expect(result.closeAgentList).not.toHaveBeenCalled();
    expect(result.openAgentList).not.toHaveBeenCalled();
  });

  it("closes both when both are showing", () => {
    const result = harness({ isAgentListOpen: true, isExplorerOpen: true });

    expect(result.closeAgentList).toHaveBeenCalledTimes(1);
    expect(result.toggleExplorer).toHaveBeenCalledTimes(1);
  });

  it("opens both when nothing is showing", () => {
    const result = harness({ isAgentListOpen: false, isExplorerOpen: false });

    expect(result.openAgentList).toHaveBeenCalledTimes(1);
    expect(result.toggleExplorer).toHaveBeenCalledTimes(1);
    expect(result.closeAgentList).not.toHaveBeenCalled();
  });
});
