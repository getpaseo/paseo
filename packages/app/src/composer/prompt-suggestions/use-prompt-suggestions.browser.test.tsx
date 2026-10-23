import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useSessionStore } from "@/stores/session-store";
import { usePromptSuggestions, type UsePromptSuggestionsInput } from "./use-prompt-suggestions";

beforeEach(() => vi.stubGlobal("React", React));

const SERVER_ID = "srv";
const AGENT_ID = "a1";

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

function renderHook(input: UsePromptSuggestionsInput): (next: UsePromptSuggestionsInput) => void {
  const Probe = ({ value }: { value: UsePromptSuggestionsInput }): null => {
    usePromptSuggestions(value);
    return null;
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<Probe value={input} />));
  mounted.push({ root, container });
  return (next) => act(() => root.render(<Probe value={next} />));
}

function seedSession(client: Partial<DaemonClient>, promptSuggestions = true): void {
  const store = useSessionStore.getState();
  store.initializeSession(SERVER_ID, client as DaemonClient);
  store.updateSessionServerInfo(SERVER_ID, {
    serverId: SERVER_ID,
    hostname: null,
    version: "test",
    features: { promptSuggestions },
  });
}

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
  useSessionStore.getState().clearSession(SERVER_ID);
});

const BASE: UsePromptSuggestionsInput = {
  serverId: SERVER_ID,
  agentId: AGENT_ID,
  hasText: false,
  isAgentRunning: false,
  isReadOnly: false,
};

describe("usePromptSuggestions", () => {
  // Suggestions live in the daemon's memory, so a chat opened after a restart
  // shows nothing at all unless the client asks for them.
  it("asks the daemon when it holds no suggestion for an idle empty composer", () => {
    const requestPromptSuggestions = vi.fn().mockResolvedValue(true);
    seedSession({ requestPromptSuggestions } as Partial<DaemonClient>);

    renderHook(BASE);

    expect(requestPromptSuggestions).toHaveBeenCalledWith(AGENT_ID);
  });

  it("never asks a host that predates the feature", () => {
    const requestPromptSuggestions = vi.fn().mockResolvedValue(true);
    seedSession({ requestPromptSuggestions } as Partial<DaemonClient>, false);

    renderHook(BASE);

    expect(requestPromptSuggestions).not.toHaveBeenCalled();
  });

  it("stays quiet while the composer has text", () => {
    const requestPromptSuggestions = vi.fn().mockResolvedValue(true);
    seedSession({ requestPromptSuggestions } as Partial<DaemonClient>);

    renderHook({ ...BASE, hasText: true });

    expect(requestPromptSuggestions).not.toHaveBeenCalled();
  });

  it("stays quiet while the agent is running", () => {
    const requestPromptSuggestions = vi.fn().mockResolvedValue(true);
    seedSession({ requestPromptSuggestions } as Partial<DaemonClient>);

    renderHook({ ...BASE, isAgentRunning: true });

    expect(requestPromptSuggestions).not.toHaveBeenCalled();
  });

  it("asks once for a chat, not once per render", () => {
    const requestPromptSuggestions = vi.fn().mockResolvedValue(true);
    seedSession({ requestPromptSuggestions } as Partial<DaemonClient>);

    const rerender = renderHook(BASE);
    rerender({ ...BASE });
    rerender({ ...BASE });

    expect(requestPromptSuggestions).toHaveBeenCalledTimes(1);
  });
});
