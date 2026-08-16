import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React, { useCallback } from "react";
import { afterEach, expect, test } from "vitest";
import { PreWorkspaceComposerGitOwner, useWorkspaceGit } from "./workspace-git";

afterEach(cleanup);

function createLegacyGitPort() {
  const statusCwds: string[] = [];
  return {
    client: {
      async getCheckoutStatus(cwd: string) {
        statusCwds.push(cwd);
        return { cwd };
      },
      async checkoutPrStatus(cwd: string) {
        return { cwd };
      },
      async searchForge() {
        return { items: [], authState: "unknown", error: null };
      },
      async searchGitHub() {
        return { items: [], error: null };
      },
    },
    statusCwds,
  };
}

function SharedComposerGitConsumer() {
  const workspaceGit = useWorkspaceGit();
  const fetchStatus = useCallback(() => {
    void workspaceGit?.getStatus();
  }, [workspaceGit]);
  return (
    <button type="button" onClick={fetchStatus}>
      {workspaceGit?.cwd ?? "Git unavailable"}
    </button>
  );
}

test.each(["terminal", "chat"])(
  "the new-workspace %s Composer production owner supplies its legacy cwd",
  async () => {
    const port = createLegacyGitPort();
    render(
      <PreWorkspaceComposerGitOwner client={port.client as never} cwd=" /draft/source ">
        <SharedComposerGitConsumer />
      </PreWorkspaceComposerGitOwner>,
    );

    fireEvent.click(screen.getByRole("button", { name: "/draft/source" }));
    await waitFor(() => expect(port.statusCwds).toEqual(["/draft/source"]));
  },
);

test("the new-workspace Composer production owner represents no cwd without crashing", () => {
  const port = createLegacyGitPort();
  render(
    <PreWorkspaceComposerGitOwner client={port.client as never} cwd={null}>
      <SharedComposerGitConsumer />
    </PreWorkspaceComposerGitOwner>,
  );

  expect(screen.getByRole("button", { name: "Git unavailable" })).toBeVisible();
  expect(port.statusCwds).toEqual([]);
});

test("the workspace-setup Composer production owner supplies its source directory", async () => {
  const port = createLegacyGitPort();
  render(
    <PreWorkspaceComposerGitOwner client={port.client as never} cwd="/setup/source">
      <SharedComposerGitConsumer />
    </PreWorkspaceComposerGitOwner>,
  );

  fireEvent.click(screen.getByRole("button", { name: "/setup/source" }));
  await waitFor(() => expect(port.statusCwds).toEqual(["/setup/source"]));
});
