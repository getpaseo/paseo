import { describe, expect, it, vi } from "vitest";
import { registerAgentTimelineNavigator, scrollAgentTimeline } from "./timeline-navigation";

describe("plugin timeline navigation", () => {
  it("routes a last-user-message request only to its mounted agent transcript", () => {
    const first = vi.fn();
    const second = vi.fn();
    const removeFirst = registerAgentTimelineNavigator("host", "first", first);
    const removeSecond = registerAgentTimelineNavigator("host", "second", second);

    scrollAgentTimeline("host", "second", "last-user-message");

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith("last-user-message");
    removeFirst();
    removeSecond();
  });

  it("does nothing after the transcript unmounts", () => {
    const navigate = vi.fn();
    const remove = registerAgentTimelineNavigator("host", "agent", navigate);
    remove();

    scrollAgentTimeline("host", "agent", "last-user-message");

    expect(navigate).not.toHaveBeenCalled();
  });
});
