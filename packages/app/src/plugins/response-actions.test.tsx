/** @vitest-environment jsdom */
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PluginResponseActionContext, PluginSpeechState } from "@getpaseo/plugin/client";

const fixture = vi.hoisted(() => ({
  speech: {
    ...({ status: "idle", key: null, error: null } as PluginSpeechState),
    speak: vi.fn(),
    stop: vi.fn(),
  },
  selected: vi.fn(),
  error: vi.fn(),
}));
vi.mock("./speech", () => ({ useSpeech: () => fixture.speech }));
vi.mock("./runtime-boundary", () => ({
  PluginRuntimeBoundary: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/runtime/host-runtime", () => ({ useHostRuntimeClient: () => ({}) }));
vi.mock("@/contexts/toast-api-context", () => ({ useToast: () => ({ error: fixture.error }) }));
vi.mock("./registry", () => ({
  useInstalledPlugins: () => [
    {
      id: "speak",
      serverId: "local",
      responseActions: [
        {
          id: "speak",
          title: "Read response aloud",
          icon: "Volume2",
          activity: (ctx: PluginResponseActionContext) => {
            if (
              ctx.speech.key !== `${ctx.agentId}/${ctx.responseId}` ||
              ctx.speech.status === "idle"
            )
              return null;
            return ctx.speech.status === "preparing"
              ? { status: "loading", label: "Preparing…" }
              : { status: "active", label: "Speaking" };
          },
          items: () => [
            {
              id: "summary",
              title: "Speak summary",
              onSelect: (ctx: PluginResponseActionContext) =>
                fixture.selected("summary", ctx.getContent()),
            },
            {
              id: "full",
              title: "Speak full response",
              onSelect: (ctx: PluginResponseActionContext) =>
                fixture.selected("full", ctx.getContent()),
            },
          ],
        },
      ],
    },
    {
      id: "foreign",
      serverId: "other-host",
      responseActions: [{ id: "foreign", title: "Wrong host", icon: "Volume2", items: () => [] }],
    },
  ],
}));

import { PluginResponseActions } from "./response-actions";

const getText = () => "Text";
const getOlderText = () => "This is the older selected response.";

beforeEach(() => {
  vi.stubGlobal("React", React);
  fixture.selected.mockReset();
  fixture.error.mockReset();
  fixture.speech.status = "idle";
  fixture.speech.key = null;
});
afterEach(cleanup);

it("shows loading and playback feedback only on the active response, and resets when stopped", () => {
  const responses = () => (
    <>
      <PluginResponseActions
        serverId="local"
        agentId="agent"
        responseId="reply"
        getContent={getText}
      />
      <PluginResponseActions
        serverId="local"
        agentId="agent"
        responseId="older"
        getContent={getOlderText}
      />
    </>
  );
  const { rerender } = render(responses());
  fixture.speech.key = "agent/reply";
  fixture.speech.status = "preparing";
  rerender(responses());
  expect(screen.getAllByText("Preparing…")).toHaveLength(1);
  expect(screen.getByLabelText("Read response aloud: Preparing…").getAttribute("aria-busy")).toBe(
    "true",
  );
  expect(screen.getAllByRole("progressbar")).toHaveLength(1);
  expect(screen.getAllByLabelText("Read response aloud")).toHaveLength(1);

  fixture.speech.status = "speaking";
  rerender(responses());
  expect(screen.getAllByText("Speaking")).toHaveLength(1);
  expect(screen.queryByText("Preparing…")).toBeNull();
  expect(screen.queryByRole("progressbar")).toBeNull();

  fixture.speech.status = "idle";
  fixture.speech.key = null;
  rerender(responses());
  expect(screen.queryByText("Speaking")).toBeNull();
  expect(screen.getAllByLabelText("Read response aloud")).toHaveLength(2);
});

it("opens a dropdown for the correct host and selects the complete clicked response", async () => {
  render(
    <PluginResponseActions
      serverId="local"
      agentId="agent"
      responseId="old-response"
      getContent={getOlderText}
    />,
  );
  expect(screen.queryByLabelText("Wrong host")).toBeNull();
  fireEvent.click(screen.getByLabelText("Read response aloud"));
  const full = await screen.findByText("Speak full response");
  expect(screen.getByText("Speak summary")).toBeDefined();
  fireEvent.click(full);
  expect(fixture.selected).toHaveBeenCalledWith("full", "This is the older selected response.");
});

it("shows action failures through the host's error UI", async () => {
  fixture.selected.mockRejectedValueOnce(new Error("Speech unavailable"));
  render(
    <PluginResponseActions
      serverId="local"
      agentId="agent"
      responseId="reply"
      getContent={getText}
    />,
  );
  fireEvent.click(screen.getByLabelText("Read response aloud"));
  fireEvent.click(await screen.findByText("Speak summary"));
  await vi.waitFor(() => expect(fixture.error).toHaveBeenCalledWith("Speech unavailable"));
});
