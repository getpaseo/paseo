import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { BackgroundRequest } from "@getpaseo/protocol/messages";
import { BackgroundActivityContent } from "./activity-panel";
import { en } from "@/i18n/resources/en";

const state = vi.hoisted(() => ({
  result: {
    snapshot: null,
    supported: true,
    connected: true,
    error: null,
    retry: vi.fn(),
  } as Record<string, unknown>,
  scroll: vi.fn(),
}));
vi.mock("@/stores/session-store-hooks", () => ({ useWorkspaceDirectory: () => "/workspace" }));
vi.mock("./use-background-activity", () => ({ useBackgroundActivity: () => state.result }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      let value: unknown = en;
      for (const part of key.split(".")) value = (value as Record<string, unknown>)?.[part];
      return typeof value === "string" ? value : key;
    },
  }),
}));

let root: Root;
let container: HTMLDivElement;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  state.scroll.mockClear();
});
function mount(width: number) {
  container = document.createElement("div");
  container.style.cssText = `width:${width}px;height:600px;display:flex`;
  document.body.appendChild(container);
  root = createRoot(container);
}
function request(id: string, cwd: string, status: BackgroundRequest["status"]): BackgroundRequest {
  return {
    id,
    cwd,
    status,
    kind: "commit",
    title: "Commit",
    workspaceId: null,
    sourceAgentId: null,
    sourceTitle: null,
    createdAt: 100,
    finishedAt: status === "completed" ? 200 : null,
    error: null,
    count: 1,
    attempts: [
      {
        id: `${id}-attempt`,
        conversationId: id,
        provider: "codex",
        configuredModel: "configured-model",
        resolvedModel: "resolved-model",
        startedAt: 100,
        finishedAt: 200,
        error: null,
      },
    ],
  };
}

it.each([360, 1100])("shows live activity, source scope, and resolved models at %ipx", (width) => {
  mount(width);
  const openTab = vi.fn();
  state.result = {
    ...state.result,
    snapshot: {
      requests: [
        request("finished", "/workspace", "completed"),
        request("running", "/workspace", "running"),
        request("elsewhere", "/other", "running"),
      ],
    },
  };
  const render = () =>
    act(() =>
      root.render(
        <BackgroundActivityContent
          serverId="host"
          workspaceId="workspace"
          cwd="/workspace"
          openTab={openTab}
        />,
      ),
    );
  render();
  const rows = container.querySelectorAll('[data-testid="background-request"]');
  expect(rows).toHaveLength(2);
  expect(rows[0].textContent).toContain("Running");
  expect(rows[0].textContent).toContain("resolved-model");
  act(() => (rows[0] as HTMLElement).click());
  expect(openTab).toHaveBeenCalledWith({
    kind: "background_thread",
    conversationId: "running",
    requestId: "running",
  });
  const scope = [...container.querySelectorAll('[role="button"]')].find(
    (el) => el.textContent === "This workspace",
  );
  act(() => (scope as HTMLElement).click());
  expect(container.querySelectorAll('[data-testid="background-request"]')).toHaveLength(3);
  expect(container.getBoundingClientRect().width).toBe(width);
});

it("keeps connection and loading failures visible with a retry action", () => {
  mount(360);
  const openTab = vi.fn();
  const retry = vi.fn();
  state.result = {
    supported: true,
    connected: false,
    snapshot: null,
    error: "Request timed out",
    retry,
  };
  act(() =>
    root.render(<BackgroundActivityContent serverId="host" cwd="/workspace" openTab={openTab} />),
  );
  expect(container.textContent).toContain("reconnecting");
  expect(container.textContent).toContain("Request timed out");
  const button = [...container.querySelectorAll('[role="button"]')].find(
    (el) => el.textContent === "Retry loading",
  );
  act(() => (button as HTMLElement).click());
  expect(retry).toHaveBeenCalledOnce();
});
