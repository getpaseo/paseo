import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { afterEach, describe, expect, it } from "vitest";
import type { RefreshAgentResult } from "@/hooks/use-agent-initialization";
import { useCodexAccountChangePrompt } from "@/hooks/use-codex-account-change-prompt";
import { i18n } from "@/i18n/i18next";
import type { CodexAccountChange } from "@/utils/codex-account-change";
import { CodexAccountChangeDialog } from "./codex-account-change-dialog";

interface RefreshAdapter {
  refresh(agentId: string): Promise<RefreshAgentResult>;
}

interface PromptEvents {
  reloaded: Array<{ result: RefreshAgentResult; accountChange: CodexAccountChange }>;
  errors: string[];
}

interface MountedPrompt {
  root: Root;
  container: HTMLDivElement;
  render(status: string): void;
}

const mountedPrompts: MountedPrompt[] = [];

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true, React });

function PromptHarness({
  status,
  adapter,
  events,
}: {
  status: string;
  adapter: RefreshAdapter;
  events: PromptEvents;
}) {
  const prompt = useCodexAccountChangePrompt({
    agentId: "agent-1",
    provider: "codex",
    status,
    runtimeInfo: {
      provider: "codex",
      sessionId: "thread-1",
      extra: {
        codexAccountChange: {
          previousLabel: "old@example.com",
          nextLabel: "new@example.com",
          revision: 1,
        },
      },
    },
    archived: false,
    isInitializing: false,
    isConnected: true,
    isPaneVisible: true,
    isPaneFocused: true,
    refreshAgent: (agentId) => adapter.refresh(agentId),
    onReloaded: (result, accountChange) => events.reloaded.push({ result, accountChange }),
    onError: (message) => events.errors.push(message),
  });

  if (!prompt.accountChange) return null;
  return (
    <CodexAccountChangeDialog
      accountChange={prompt.accountChange}
      visible={prompt.visible}
      isReloading={prompt.isReloading}
      onKeepCurrentSession={prompt.keepCurrentSession}
      onReloadAgent={prompt.reloadAgent}
    />
  );
}

function mountPrompt(adapter: RefreshAdapter, events: PromptEvents, initialStatus = "idle") {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = (status: string) => {
    act(() =>
      root.render(
        <I18nextProvider i18n={i18n}>
          <PromptHarness status={status} adapter={adapter} events={events} />
        </I18nextProvider>,
      ),
    );
  };
  render(initialStatus);
  mountedPrompts.push({ root, container, render });
  return { root, container, render };
}

function byTestId(testID: string): HTMLElement {
  const element = document.querySelector(`[data-testid="${testID}"]`);
  if (!(element instanceof HTMLElement)) throw new Error(`${testID} did not render`);
  return element;
}

function click(element: HTMLElement): void {
  act(() => element.click());
}

async function waitUntil(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for browser state");
    await new Promise((resolve) => window.setTimeout(resolve, 10));
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function emptyEvents(): PromptEvents {
  return { reloaded: [], errors: [] };
}

afterEach(() => {
  for (const mounted of mountedPrompts.splice(0)) {
    act(() => mounted.root.unmount());
    mounted.container.remove();
  }
});

describe("Codex account change prompt", () => {
  it("waits for the agent to become idle and dismisses the current account transition", async () => {
    const calls: string[] = [];
    const adapter: RefreshAdapter = {
      refresh: async (agentId) => {
        calls.push(agentId);
        return {};
      },
    };
    const mounted = mountPrompt(adapter, emptyEvents(), "running");

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    mounted.render("idle");

    expect(byTestId("codex-account-change-dialog").textContent).toContain(
      "This agent is using old@example.com, but Codex is now signed in as new@example.com.",
    );
    click(byTestId("codex-account-change-keep"));
    await waitUntil(() => document.querySelector('[role="dialog"]') === null);
    expect(calls).toEqual([]);
  });

  it("locks duplicate reloads and closes after the new account is verified", async () => {
    const pending = deferred<RefreshAgentResult>();
    const calls: string[] = [];
    const events = emptyEvents();
    mountPrompt(
      {
        refresh: (agentId) => {
          calls.push(agentId);
          return pending.promise;
        },
      },
      events,
    );

    const reload = byTestId("codex-account-change-reload");
    act(() => {
      reload.click();
      reload.click();
    });

    expect(calls).toEqual(["agent-1"]);
    expect(byTestId("codex-account-change-keep").getAttribute("aria-disabled")).toBe("true");
    expect(byTestId("codex-account-change-reload").textContent).toContain("Reloading agent...");

    const result: RefreshAgentResult = {
      providerAccountLabel: "new@example.com",
      providerAccountVerificationStatus: "verified",
    };
    await act(async () => pending.resolve(result));
    await waitUntil(() => document.querySelector('[role="dialog"]') === null);
    expect(events.reloaded).toEqual([
      {
        result,
        accountChange: expect.objectContaining({ nextLabel: "new@example.com" }),
      },
    ]);
    expect(events.errors).toEqual([]);
  });

  it("keeps the prompt actionable when reload fails", async () => {
    const pending = deferred<RefreshAgentResult>();
    const events = emptyEvents();
    mountPrompt({ refresh: () => pending.promise }, events);

    click(byTestId("codex-account-change-reload"));
    await act(async () => pending.reject(new Error("active writer")));
    await waitUntil(() => events.errors.length === 1);

    expect(events.errors).toEqual(["active writer"]);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(byTestId("codex-account-change-keep").getAttribute("aria-disabled")).toBeNull();
    expect(byTestId("codex-account-change-reload").textContent).toContain("Reload agent");
  });
});
