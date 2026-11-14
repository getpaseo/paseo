import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import React, { type ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { AssistantFileLinkResolverProvider } from "@/assistant-file-links";
import type { DismissToast, ToastApi } from "@/components/toast-host";
import type { NavigateToAgentInput } from "@/utils/navigate-to-agent";
import { MarkdownRenderer } from "./renderer";

interface ToastCall {
  variant: "show" | "copied" | "error";
  content: ReactNode;
}

const mountedQueryClients: QueryClient[] = [];
const QUERY_CLIENT_OPTIONS = {
  defaultOptions: { queries: { retry: false } },
};
const noopDismiss: DismissToast = () => {};

function createTestToast(calls: ToastCall[]): ToastApi {
  return {
    show: (content) => {
      calls.push({ variant: "show", content });
      return noopDismiss;
    },
    copied: (label) => {
      calls.push({ variant: "copied", content: label ?? "" });
    },
    error: (message) => {
      calls.push({ variant: "error", content: message });
    },
  };
}

const DEFAULT_DIRECTORY_SUGGESTIONS = async () => ({ entries: [] as never[], error: null as null });
const DEFAULT_OPEN_WORKSPACE_FILE = () => {};

function createTestClient(
  getDirectorySuggestions?: () => Promise<{ entries: never[]; error: null }>,
) {
  return {
    getDirectorySuggestions: getDirectorySuggestions ?? DEFAULT_DIRECTORY_SUGGESTIONS,
  };
}

interface MountOptions {
  text: string;
  onLinkPress?: (url: string) => void;
  onNavigateToAgent?: (target: NavigateToAgentInput) => void;
  onOpenExternalUrl?: (url: string) => void | Promise<void>;
  getDirectorySuggestions?: () => Promise<{ entries: never[]; error: null }>;
  onOpenWorkspaceFile?: () => void;
  toast?: ToastApi;
}

function mountMarkdown(options: MountOptions): HTMLElement {
  const queryClient = new QueryClient(QUERY_CLIENT_OPTIONS);
  mountedQueryClients.push(queryClient);
  const client = createTestClient(options.getDirectorySuggestions);
  const onOpenWorkspaceFile = options.onOpenWorkspaceFile ?? DEFAULT_OPEN_WORKSPACE_FILE;
  const toast = options.toast ?? createTestToast([]);

  const { container } = render(
    <QueryClientProvider client={queryClient}>
      <AssistantFileLinkResolverProvider
        client={client}
        serverId="srv_1"
        workspaceRoot="/repo"
        onOpenWorkspaceFile={onOpenWorkspaceFile}
        onNavigateToAgent={options.onNavigateToAgent}
        onOpenExternalUrl={options.onOpenExternalUrl}
        toast={toast}
      >
        <MarkdownRenderer text={options.text} onLinkPress={options.onLinkPress} />
      </AssistantFileLinkResolverProvider>
    </QueryClientProvider>,
  );

  return container;
}

async function waitForAnchors(container: HTMLElement, count: number): Promise<HTMLAnchorElement[]> {
  return waitFor(
    () => {
      const anchors = [...container.querySelectorAll<HTMLAnchorElement>("a")];
      expect(anchors).toHaveLength(count);
      return anchors;
    },
    { timeout: 5_000 },
  );
}

async function waitForSingleAnchor(container: HTMLElement): Promise<HTMLAnchorElement> {
  const [anchor] = await waitForAnchors(container, 1);
  if (!anchor) {
    throw new Error("Expected 1 anchor");
  }
  return anchor;
}

async function settleRender(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 75));
}

afterEach(() => {
  cleanup();
  for (const queryClient of mountedQueryClients.splice(0)) {
    queryClient.clear();
  }
});

describe("MarkdownRenderer paseo:// agent deep links (browser)", () => {
  it("renders explicit, bare-prose, and inline-code agent links and navigates in-app on click", async () => {
    const directoryLookups: number[] = [];
    const openedWorkspaceFiles: number[] = [];
    const navigatedAgents: NavigateToAgentInput[] = [];
    const openedExternalUrls: string[] = [];
    const toastCalls: ToastCall[] = [];
    const markdown = [
      "[跳转到会话](paseo://h/srv_1/agent/a_1)",
      "",
      "见 paseo://h/srv_2/agent/a_2，以及 (paseo://h/srv%203/agent/a%3A3)。",
      "",
      "`paseo://h/srv_4/agent/a_4`",
    ].join("\n");

    const container = mountMarkdown({
      text: markdown,
      getDirectorySuggestions: async () => {
        directoryLookups.push(1);
        return { entries: [], error: null };
      },
      onOpenWorkspaceFile: () => {
        openedWorkspaceFiles.push(1);
      },
      onNavigateToAgent: (target) => {
        navigatedAgents.push(target);
      },
      onOpenExternalUrl: (url) => {
        openedExternalUrls.push(url);
      },
      toast: createTestToast(toastCalls),
    });
    const anchors = await waitForAnchors(container, 4);

    expect(anchors.map((anchor) => anchor.getAttribute("href"))).toEqual([
      "paseo://h/srv_1/agent/a_1",
      "paseo://h/srv_2/agent/a_2",
      "paseo://h/srv%203/agent/a%3A3",
      "paseo://h/srv_4/agent/a_4",
    ]);
    expect(anchors.map((anchor) => anchor.textContent)).toEqual([
      "跳转到会话",
      "paseo://h/srv_2/agent/a_2",
      "paseo://h/srv%203/agent/a%3A3",
      "paseo://h/srv_4/agent/a_4",
    ]);
    expect(container.textContent).toContain(
      "见 paseo://h/srv_2/agent/a_2，以及 (paseo://h/srv%203/agent/a%3A3)。",
    );

    for (const anchor of anchors) {
      fireEvent.mouseOver(anchor);
      fireEvent.click(anchor);
    }

    expect(navigatedAgents).toEqual([
      { serverId: "srv_1", agentId: "a_1" },
      { serverId: "srv_2", agentId: "a_2" },
      { serverId: "srv 3", agentId: "a:3" },
      { serverId: "srv_4", agentId: "a_4" },
    ]);
    expect(openedExternalUrls).toEqual([]);
    expect(directoryLookups).toEqual([]);
    expect(openedWorkspaceFiles).toEqual([]);
    expect(toastCalls).toEqual([]);
  });

  it("handles agent deep links before onLinkPress (e.g. PR comment panels)", async () => {
    const navigatedAgents: NavigateToAgentInput[] = [];
    const openedExternalUrls: string[] = [];
    const customPressedUrls: string[] = [];
    const container = mountMarkdown({
      text: "Check [agent](paseo://h/srv_pr/agent/a_pr) or https://example.com/pr/1.",
      onLinkPress: (url) => {
        customPressedUrls.push(url);
      },
      onNavigateToAgent: (target) => {
        navigatedAgents.push(target);
      },
      onOpenExternalUrl: (url) => {
        openedExternalUrls.push(url);
      },
    });
    const anchors = await waitForAnchors(container, 2);

    for (const anchor of anchors) {
      fireEvent.click(anchor);
    }

    expect(navigatedAgents).toEqual([{ serverId: "srv_pr", agentId: "a_pr" }]);
    expect(customPressedUrls).toEqual(["https://example.com/pr/1"]);
    expect(openedExternalUrls).toEqual([]);
  });

  it("leaves malformed bare/inline-code paseo:// text unlinked and dispatches explicit invalid links to onOpenExternalUrl", async () => {
    const directoryLookups: number[] = [];
    const openedWorkspaceFiles: number[] = [];
    const navigatedAgents: NavigateToAgentInput[] = [];
    const openedExternalUrls: string[] = [];
    const toastCalls: ToastCall[] = [];
    const container = mountMarkdown({
      text: [
        "Plain paseo://invalid and paseo://h/srv_remote/agent/agent_target#章节",
        "and paseo://h/srv_remote/agent/agent_target?章节",
        "and paseo://h/srv_remote/agent/agent_target/extra",
        "and paseo://h/srv_remote/agent/agent_target%ZZ",
        "and `paseo://foo/bar` and `paseo://h/srv_remote/agent/agent_target#章节`",
        "and `paseo://h/srv_remote/agent/agent_target/` and `paseo://h/srv_remote/agent/agent_target#`",
        "and [bad](paseo://invalid).",
      ].join(" "),
      getDirectorySuggestions: async () => {
        directoryLookups.push(1);
        return { entries: [], error: null };
      },
      onOpenWorkspaceFile: () => {
        openedWorkspaceFiles.push(1);
      },
      onNavigateToAgent: (target) => {
        navigatedAgents.push(target);
      },
      onOpenExternalUrl: (url) => {
        openedExternalUrls.push(url);
      },
      toast: createTestToast(toastCalls),
    });

    const anchor = await waitForSingleAnchor(container);
    await settleRender();

    expect(container.querySelectorAll("a")).toHaveLength(1);
    expect(anchor.getAttribute("href")).toBe("paseo://invalid");
    expect(anchor.textContent).toBe("bad");

    fireEvent.mouseOver(anchor);
    fireEvent.click(anchor);

    expect(navigatedAgents).toEqual([]);
    expect(openedExternalUrls).toEqual(["paseo://invalid"]);
    expect(directoryLookups).toEqual([]);
    expect(openedWorkspaceFiles).toEqual([]);
    expect(toastCalls).toEqual([]);
  });

  it("safely ignores explicit invalid paseo:// links when using the default external URL opener", async () => {
    const directoryLookups: number[] = [];
    const openedWorkspaceFiles: number[] = [];
    const navigatedAgents: NavigateToAgentInput[] = [];
    const toastCalls: ToastCall[] = [];
    const container = mountMarkdown({
      text: "[bad](paseo://invalid)",
      getDirectorySuggestions: async () => {
        directoryLookups.push(1);
        return { entries: [], error: null };
      },
      onOpenWorkspaceFile: () => {
        openedWorkspaceFiles.push(1);
      },
      onNavigateToAgent: (target) => {
        navigatedAgents.push(target);
      },
      toast: createTestToast(toastCalls),
    });

    const anchor = await waitForSingleAnchor(container);
    await settleRender();

    expect(container.querySelectorAll("a")).toHaveLength(1);
    fireEvent.click(anchor);

    expect(navigatedAgents).toEqual([]);
    expect(directoryLookups).toEqual([]);
    expect(openedWorkspaceFiles).toEqual([]);
    expect(toastCalls).toEqual([]);
  });
});
