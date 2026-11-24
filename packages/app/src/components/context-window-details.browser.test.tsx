import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentMetric } from "@getpaseo/protocol/agent-types";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { i18n } from "@/i18n/i18next";
import { ContextWindowDetails } from "./context-window-details";

const CONTEXT = { percentage: 40, usedTokens: 80_000, maxTokens: 200_000 };

let root: Root;
let host: HTMLDivElement;

beforeEach(async () => {
  await i18n.changeLanguage("en");
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function renderDetails(sessionMetrics: AgentMetric[]): void {
  act(() =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <ContextWindowDetails
          serverId="server"
          agentId="agent"
          context={CONTEXT}
          sessionCost="$1.20"
          sessionMetrics={sessionMetrics}
          showTitle
          refreshable={false}
        />
      </QueryClientProvider>,
    ),
  );
}

it("shows what the provider reports about the session", async () => {
  renderDetails([
    { label: "Model", value: "opus" },
    { label: "Requests", value: "12" },
  ]);

  await expect.element(page.getByText("Model")).toBeVisible();
  await expect.element(page.getByText("opus")).toBeVisible();
  await expect.element(page.getByText("Requests")).toBeVisible();
  await expect.element(page.getByText("Session cost $1.20")).toBeVisible();
});

it("leaves the cost to the provider when it reports one", async () => {
  renderDetails([{ label: "Cost", value: "$1.25" }]);

  await expect.element(page.getByText("$1.25")).toBeVisible();
  expect(page.getByText("Session cost $1.20").elements()).toHaveLength(0);
});
