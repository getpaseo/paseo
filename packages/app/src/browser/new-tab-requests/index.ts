import { useEffect } from "react";
import { getDesktopHost, type DesktopBrowserNewTabRequestEvent } from "@/desktop/host";
import { collectAllTabs, type WorkspaceLayout } from "@/stores/workspace-layout-store";
import { getIsElectron } from "@/constants/platform";
import { useStableEvent } from "@/hooks/use-stable-event";

export type BrowserNewTabRequest = DesktopBrowserNewTabRequestEvent;

function isAllowedBrowserNewTabUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.href === "about:blank"
    );
  } catch {
    return false;
  }
}

function readDesktopBrowserNewTabRequest(payload: unknown): BrowserNewTabRequest | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const candidate = payload as Partial<BrowserNewTabRequest>;
  if (typeof candidate.sourceBrowserId !== "string" || !candidate.sourceBrowserId.trim()) {
    return null;
  }
  if (typeof candidate.url !== "string" || !isAllowedBrowserNewTabUrl(candidate.url)) {
    return null;
  }
  return {
    sourceBrowserId: candidate.sourceBrowserId,
    url: candidate.url,
  };
}

function workspaceContainsBrowser(input: {
  workspaceLayout: WorkspaceLayout | null | undefined;
  browserId: string;
}): boolean {
  if (!input.workspaceLayout) {
    return false;
  }
  return collectAllTabs(input.workspaceLayout.root).some((tab) => {
    return tab.target.kind === "browser" && tab.target.browserId === input.browserId;
  });
}

export function resolveBrowserNewTabRequest(input: {
  payload: unknown;
  workspaceLayout: WorkspaceLayout | null | undefined;
}): BrowserNewTabRequest | null {
  const request = readDesktopBrowserNewTabRequest(input.payload);
  if (!request) {
    return null;
  }
  if (
    !workspaceContainsBrowser({
      workspaceLayout: input.workspaceLayout,
      browserId: request.sourceBrowserId,
    })
  ) {
    return null;
  }
  return request;
}

export function useDesktopBrowserNewTabRequests(input: {
  enabled: boolean;
  workspaceLayout: WorkspaceLayout | null | undefined;
  openUrl: (url: string) => void;
}): void {
  const handleNewTabRequest = useStableEvent((payload: unknown) => {
    const request = resolveBrowserNewTabRequest({
      payload,
      workspaceLayout: input.workspaceLayout,
    });
    if (!request) {
      return;
    }
    input.openUrl(request.url);
  });

  useEffect(() => {
    if (!input.enabled || !getIsElectron()) {
      return;
    }
    const unsubscribe = getDesktopHost()?.events?.on?.(
      "browser-new-tab-request",
      handleNewTabRequest,
    );
    if (typeof unsubscribe === "function") {
      return unsubscribe;
    }
    return () => {
      void unsubscribe?.then((dispose) => dispose());
    };
  }, [handleNewTabRequest, input.enabled]);
}
