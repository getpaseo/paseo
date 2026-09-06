import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSelectedAssistantId, useAssistantSelectionStore } from "./assistant-selection-store";

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => null),
    setItem: vi.fn(async () => undefined),
    removeItem: vi.fn(async () => undefined),
  },
}));

describe("assistant selection store", () => {
  beforeEach(() => {
    useAssistantSelectionStore.setState({ selectedByServerId: {} });
  });

  it("keeps one selection per host", () => {
    const { select } = useAssistantSelectionStore.getState();
    select("host-a", "ast_" + "a".repeat(32));
    select("host-b", "ast_" + "b".repeat(32));
    expect(getSelectedAssistantId("host-a")).toBe("ast_" + "a".repeat(32));
    expect(getSelectedAssistantId("host-b")).toBe("ast_" + "b".repeat(32));
    select("host-a", null);
    expect(getSelectedAssistantId("host-a")).toBeNull();
    expect(getSelectedAssistantId("host-b")).toBe("ast_" + "b".repeat(32));
  });

  it("drops a selection whose assistant no longer exists on that host", () => {
    const { select, reconcile } = useAssistantSelectionStore.getState();
    const kept = "ast_" + "1".repeat(32);
    const deleted = "ast_" + "2".repeat(32);
    select("host-a", deleted);
    select("host-b", kept);
    reconcile("host-a", [kept]);
    expect(getSelectedAssistantId("host-a")).toBeNull();
    // Another host's list says nothing about this host's selection.
    reconcile("host-b", [kept]);
    expect(getSelectedAssistantId("host-b")).toBe(kept);
  });

  it("does not publish a new state when nothing changed", () => {
    const { select, reconcile } = useAssistantSelectionStore.getState();
    const id = "ast_" + "3".repeat(32);
    select("host-a", id);
    const before = useAssistantSelectionStore.getState();
    reconcile("host-a", [id]);
    expect(useAssistantSelectionStore.getState()).toBe(before);
  });
});
