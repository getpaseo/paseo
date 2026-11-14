import { describe, expect, it, vi } from "vitest";
import {
  previousUserMessageId,
  registerAgentTimelineNavigator,
  scrollAgentTimeline,
} from "./timeline-navigation";

describe("previousUserMessageId", () => {
  const userMessageIds = ["user-1", "user-2", "user-3"];

  it("starts at the newest user message and steps backward", () => {
    expect(previousUserMessageId(userMessageIds, null)).toBe("user-3");
    expect(previousUserMessageId(userMessageIds, "user-3")).toBe("user-2");
    expect(previousUserMessageId(userMessageIds, "user-2")).toBe("user-1");
  });

  it("stays on the oldest user message when there is no earlier message", () => {
    expect(previousUserMessageId(userMessageIds, "user-1")).toBe("user-1");
  });

  it("restarts from the newest message after a reset cursor", () => {
    expect(previousUserMessageId(userMessageIds, "missing-message")).toBe("user-3");
    expect(previousUserMessageId([], null)).toBeNull();
  });
});

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
