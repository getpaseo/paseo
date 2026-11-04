import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import type { WorkspaceScriptPayload } from "@getpaseo/protocol/messages";
import { i18n } from "@/i18n/i18next";
import { ToastApiProvider } from "@/contexts/toast-api-context";
import {
  useWorkspaceScriptActions,
  type UseWorkspaceScriptActionsInput,
} from "./use-workspace-script-actions";

vi.stubGlobal("React", React);
const toast = { show: () => () => {}, copied: () => {}, error: () => {} };
const running: WorkspaceScriptPayload = {
  scriptName: "dev",
  type: "script",
  hostname: "dev",
  port: null,
  proxyUrl: null,
  lifecycle: "running",
  health: null,
  exitCode: null,
  terminalId: "terminal-1",
};
const runningScripts = [running];
const stoppedScripts = [{ ...running, lifecycle: "stopped" as const }];

it("finishes restart after the menu is removed before the stopped status arrives", async () => {
  await i18n.changeLanguage("en");
  const calls: string[] = [];
  const client: NonNullable<UseWorkspaceScriptActionsInput["client"]> = {
    async killTerminal(terminalId) {
      calls.push(`stop:${terminalId}`);
      return { terminalId, success: true, requestId: "stop-1" };
    },
    async startWorkspaceScript(workspaceId, scriptName) {
      calls.push(`start:${workspaceId}:${scriptName}`);
      return {
        terminalId: "terminal-2",
        workspaceId,
        scriptName,
        requestId: "start-1",
        error: null,
      };
    },
  };
  function Workspace({
    scripts,
    showMenu,
  }: {
    scripts: WorkspaceScriptPayload[];
    showMenu: boolean;
  }) {
    const actions = useWorkspaceScriptActions({
      client,
      serverId: "script-owner-test",
      workspaceId: "workspace-1",
      scripts,
    });
    const restart = React.useCallback(() => actions.restart("dev"), [actions]);
    return showMenu ? (
      <button type="button" data-testid="restart" onClick={restart}>
        Restart
      </button>
    ) : null;
  }
  const queryClient = new QueryClient();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  function render(scripts: WorkspaceScriptPayload[], showMenu: boolean) {
    return act(async () =>
      root.render(
        <QueryClientProvider client={queryClient}>
          <ToastApiProvider api={toast}>
            <Workspace scripts={scripts} showMenu={showMenu} />
          </ToastApiProvider>
        </QueryClientProvider>,
      ),
    );
  }
  try {
    await render(runningScripts, true);
    await page.getByTestId("restart").click();
    await expect.poll(() => calls).toEqual(["stop:terminal-1"]);
    await render(runningScripts, false);
    expect(container.childElementCount).toBe(0);
    expect(calls).toEqual(["stop:terminal-1"]);
    await render(stoppedScripts, false);
    await expect.poll(() => calls).toEqual(["stop:terminal-1", "start:workspace-1:dev"]);
  } finally {
    act(() => root.unmount());
    queryClient.clear();
    container.remove();
  }
});
