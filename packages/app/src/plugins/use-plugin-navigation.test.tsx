/**
 * @vitest-environment jsdom
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { usePluginNavigation } from "./use-plugin-navigation";

vi.mock("@/utils/navigate-to-agent", () => ({
  navigateToAgent: vi.fn(),
}));

const navigateToAgentMock = vi.mocked(navigateToAgent);

describe("usePluginNavigation", () => {
  beforeEach(() => {
    navigateToAgentMock.mockReset();
  });

  it("opens an agent on the rendering host", () => {
    const { result } = renderHook(() => usePluginNavigation("host-1"));

    act(() => result.current.openAgent("agent-1"));

    expect(navigateToAgentMock).toHaveBeenCalledWith({ serverId: "host-1", agentId: "agent-1" });
  });

  it("keeps the capability stable until the rendering host changes", () => {
    const { result, rerender } = renderHook(({ serverId }) => usePluginNavigation(serverId), {
      initialProps: { serverId: "host-1" },
    });
    const initialNavigation = result.current;

    rerender({ serverId: "host-1" });
    expect(result.current).toBe(initialNavigation);

    rerender({ serverId: "host-2" });
    expect(result.current).not.toBe(initialNavigation);

    act(() => result.current.openAgent("agent-2"));
    expect(navigateToAgentMock).toHaveBeenCalledWith({ serverId: "host-2", agentId: "agent-2" });
  });
});
