/** @vitest-environment jsdom */
import React from "react";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ASSISTANT_CONFIGURATION, type Assistant } from "@getpaseo/protocol/assistants";
import { AssistantHistoryView } from "./assistant-history-view";

const state = vi.hoisted(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: false,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
    }),
  });
  return { assistant: null as Assistant | null, loadOlder: vi.fn() };
});
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("./assistant-queries", () => ({
  useAssistantHistory: () => ({
    assistant: state.assistant,
    entries: [],
    hasMore: true,
    isLoading: false,
    isLoadingOlder: false,
    error: null,
    loadOlder: state.loadOlder,
  }),
}));

vi.stubGlobal("React", React);
afterEach(cleanup);

const original: Assistant = {
  id: `ast_${"a".repeat(32)}`,
  name: "Work",
  templateId: null,
  configuration: DEFAULT_ASSISTANT_CONFIGURATION,
  revision: 1,
  createdAt: "now",
  updatedAt: "now",
  summary: "",
  summaryThroughSeq: 0,
  lastSeq: 10,
};
beforeEach(() => {
  state.assistant = original;
  state.loadOlder.mockReset();
});

describe("assistant history editing", () => {
  it("keeps the summary's original checkpoint while new history and a conflicting revision arrive", async () => {
    state.assistant = original;
    const onCompact = vi.fn().mockRejectedValue(new Error("Reload before saving"));
    const screen = render(
      <AssistantHistoryView
        serverId="host"
        assistantId={original.id}
        disabled={false}
        onCompact={onCompact}
      />,
    );
    fireEvent.change(screen.getByLabelText("assistants.history.summary.label"), {
      target: { value: "Iris releases Monday" },
    });
    state.assistant = { ...original, revision: 2, lastSeq: 20 };
    screen.rerender(
      <AssistantHistoryView
        serverId="host"
        assistantId={original.id}
        disabled={false}
        onCompact={onCompact}
      />,
    );
    fireEvent.click(screen.getByText("assistants.history.summary.save"));
    await waitFor(() =>
      expect(onCompact).toHaveBeenCalledWith({
        assistant: original,
        summary: "Iris releases Monday",
        throughSeq: 10,
      }),
    );
    expect(await screen.findByText("Reload before saving")).toBeTruthy();
    expect(
      (screen.getByLabelText("assistants.history.summary.label") as HTMLTextAreaElement).value,
    ).toBe("Iris releases Monday");
  });

  it("shows a failed older-history request in the current view", async () => {
    state.loadOlder.mockRejectedValue(new Error("Host disconnected"));
    const screen = render(
      <AssistantHistoryView
        serverId="host"
        assistantId={state.assistant!.id}
        disabled={false}
        onCompact={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText("assistants.history.loadOlder"));
    expect(await screen.findByText("Host disconnected")).toBeTruthy();
  });
});
