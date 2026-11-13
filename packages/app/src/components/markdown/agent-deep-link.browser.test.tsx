import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantFileLinkResolverProvider } from "@/assistant-file-links";
import type { ToastApi } from "@/components/toast-host";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { openExternalUrl } from "@/utils/open-external-url";
import { MarkdownRenderer } from "./renderer";

vi.mock("@/utils/navigate-to-agent", () => ({
  navigateToAgent: vi.fn(
    (target: { serverId: string; agentId: string }) =>
      `/h/${target.serverId}/agent/${target.agentId}`,
  ),
}));

vi.mock("@/utils/open-external-url", () => ({
  openExternalUrl: vi.fn(async () => {}),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface MountedMarkdown {
  root: Root;
  container: HTMLDivElement;
  queryClient: QueryClient;
}

const mountedViews: MountedMarkdown[] = [];
const QUERY_CLIENT_OPTIONS = {
  defaultOptions: { queries: { retry: false } },
};

function createTestToast(): ToastApi {
  return {
    show: vi.fn<ToastApi["show"]>(),
    copied: vi.fn<ToastApi["copied"]>(),
    error: vi.fn<ToastApi["error"]>(),
  };
}

function createTestClient(
  getDirectorySuggestions?: () => Promise<{ entries: never[]; error: null }>,
) {
  return {
    getDirectorySuggestions:
      getDirectorySuggestions ?? vi.fn(async () => ({ entries: [], error: null })),
  };
}

interface MountOptions {
  text: string;
  onLinkPress?: (url: string) => void;
  getDirectorySuggestions?: () => Promise<{ entries: never[]; error: null }>;
  onOpenWorkspaceFile?: () => void;
  toast?: ToastApi;
}

async function mountMarkdown(options: MountOptions): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient(QUERY_CLIENT_OPTIONS);
  const client = createTestClient(options.getDirectorySuggestions);
  const onOpenWorkspaceFile = options.onOpenWorkspaceFile ?? vi.fn();
  const toast = options.toast ?? createTestToast();

  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <AssistantFileLinkResolverProvider
          client={client}
          serverId="srv_1"
          workspaceRoot="/repo"
          onOpenWorkspaceFile={onOpenWorkspaceFile}
          toast={toast}
        >
          <MarkdownRenderer text={options.text} onLinkPress={options.onLinkPress} />
        </AssistantFileLinkResolverProvider>
      </QueryClientProvider>,
    );
  });

  mountedViews.push({ root, container, queryClient });
  return container;
}

async function waitForAnchors(
  container: HTMLDivElement,
  count: number,
): Promise<HTMLAnchorElement[]> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const anchors = [...container.querySelectorAll<HTMLAnchorElement>("a")];
    if (anchors.length >= count) return anchors;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  }
  const anchors = [...container.querySelectorAll<HTMLAnchorElement>("a")];
  expect(anchors.length).toBeGreaterThanOrEqual(count);
  return anchors;
}

async function settleRender(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 75));
  });
}

beforeEach(() => {
  vi.mocked(navigateToAgent).mockClear();
  vi.mocked(openExternalUrl).mockClear();
});

afterEach(() => {
  for (const mounted of mountedViews.splice(0)) {
    act(() => mounted.root.unmount());
    mounted.queryClient.clear();
    mounted.container.remove();
  }
});

describe("MarkdownRenderer paseo:// agent deep links (browser)", () => {
  it("renders explicit, bare-prose, and inline-code agent links and navigates in-app on click", async () => {
    const getDirectorySuggestions = vi.fn(async () => ({ entries: [], error: null }));
    const onOpenWorkspaceFile = vi.fn();
    const toast = createTestToast();
    const markdown = [
      "[跳转到会话](paseo://h/srv_1/agent/a_1)",
      "",
      "见 paseo://h/srv_2/agent/a_2，以及 (paseo://h/srv%203/agent/a%3A3)。",
      "",
      "`paseo://h/srv_4/agent/a_4`",
    ].join("\n");

    const container = await mountMarkdown({
      text: markdown,
      getDirectorySuggestions,
      onOpenWorkspaceFile,
      toast,
    });
    const anchors = await waitForAnchors(container, 4);

    expect(anchors.map((anchor) => anchor.getAttribute("href"))).toEqual([
      "paseo://h/srv_1/agent/a_1",
      "paseo://h/srv_2/agent/a_2",
      "paseo://h/srv%203/agent/a%3A3",
      "paseo://h/srv_4/agent/a_4",
    ]);
    expect(anchors[0]?.textContent).toBe("跳转到会话");
    expect(anchors[1]?.textContent).toBe("paseo://h/srv_2/agent/a_2");
    expect(anchors[2]?.textContent).toBe("paseo://h/srv%203/agent/a%3A3");
    expect(anchors[3]?.textContent).toBe("paseo://h/srv_4/agent/a_4");
    expect(container.textContent).toContain(
      "见 paseo://h/srv_2/agent/a_2，以及 (paseo://h/srv%203/agent/a%3A3)。",
    );

    for (const anchor of anchors) {
      await act(async () => {
        anchor.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        anchor.click();
      });
    }

    expect(vi.mocked(navigateToAgent).mock.calls).toEqual([
      [{ serverId: "srv_1", agentId: "a_1" }],
      [{ serverId: "srv_2", agentId: "a_2" }],
      [{ serverId: "srv 3", agentId: "a:3" }],
      [{ serverId: "srv_4", agentId: "a_4" }],
    ]);
    expect(openExternalUrl).not.toHaveBeenCalled();
    expect(getDirectorySuggestions).not.toHaveBeenCalled();
    expect(onOpenWorkspaceFile).not.toHaveBeenCalled();
    expect(toast.show).not.toHaveBeenCalled();
  });

  it("handles agent deep links before onLinkPress (e.g. PR comment panels)", async () => {
    const onLinkPress = vi.fn();
    const container = await mountMarkdown({
      text: "Check [agent](paseo://h/srv_pr/agent/a_pr) or https://example.com/pr/1.",
      onLinkPress,
    });
    const anchors = await waitForAnchors(container, 2);

    await act(async () => {
      anchors[0]?.click();
      anchors[1]?.click();
    });

    expect(navigateToAgent).toHaveBeenCalledTimes(1);
    expect(navigateToAgent).toHaveBeenCalledWith({ serverId: "srv_pr", agentId: "a_pr" });
    expect(onLinkPress).toHaveBeenCalledTimes(1);
    expect(onLinkPress).toHaveBeenCalledWith("https://example.com/pr/1");
  });

  it("leaves invalid bare/inline-code paseo:// text unlinked and safely ignores explicit invalid links", async () => {
    const getDirectorySuggestions = vi.fn(async () => ({ entries: [], error: null }));
    const onOpenWorkspaceFile = vi.fn();
    const toast = createTestToast();
    const container = await mountMarkdown({
      text: "Plain paseo://invalid and `paseo://foo/bar` and [bad](paseo://invalid).",
      getDirectorySuggestions,
      onOpenWorkspaceFile,
      toast,
    });

    const anchors = await waitForAnchors(container, 1);
    await settleRender();

    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.getAttribute("href")).toBe("paseo://invalid");
    expect(anchors[0]?.textContent).toBe("bad");

    await act(async () => {
      anchors[0]?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      anchors[0]?.click();
    });

    expect(navigateToAgent).not.toHaveBeenCalled();
    expect(openExternalUrl).toHaveBeenCalledWith("paseo://invalid");
    expect(getDirectorySuggestions).not.toHaveBeenCalled();
    expect(onOpenWorkspaceFile).not.toHaveBeenCalled();
    expect(toast.show).not.toHaveBeenCalled();
  });
});
