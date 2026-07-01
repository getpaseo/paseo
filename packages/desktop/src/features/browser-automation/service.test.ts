import { resolve as resolvePath } from "node:path";

import { describe, expect, it } from "vitest";
import { BrowserSnapshotEngine } from "./snapshot-engine.js";
import type { TabContents, BrowserRegistry } from "./service.js";
import { executeAutomationCommand } from "./service.js";

function fakeTab(overrides: Partial<TabContents> & { id: number }): TabContents {
  return {
    getURL: () => "https://example.com",
    getTitle: () => "Example",
    canGoBack: () => false,
    canGoForward: () => false,
    isLoading: () => false,
    isDestroyed: () => false,
    executeJavaScript: async () => "[]",
    loadURL: async () => {},
    goBack: () => {},
    goForward: () => {},
    reload: () => {},
    capturePage: async () => ({
      toPNG: () => new Uint8Array([137, 80, 78, 71]),
      getSize: () => ({ width: 10, height: 5 }),
    }),
    ...overrides,
  };
}

function createRegistry(overrides: Partial<BrowserRegistry> = {}): BrowserRegistry {
  return {
    listRegisteredBrowserIds: () => [],
    listRegisteredBrowserIdsForWorkspace: () => [],
    getTabContents: () => null,
    getBrowserWorkspaceId: () => null,
    getWorkspaceActiveTabContents: () => null,
    getWorkspaceActiveBrowserId: () => null,
    getAgentActiveBrowserId: () => null,
    ...overrides,
  };
}

function hasScriptWith(scripts: string[], first: string, second: string): boolean {
  for (const script of scripts) {
    if (script.includes(first) && script.includes(second)) {
      return true;
    }
  }
  return false;
}

const TAB_A = fakeTab({ id: 1, getURL: () => "https://a.com", getTitle: () => "Tab A" });
const TAB_B = fakeTab({ id: 2, getURL: () => "https://b.com", getTitle: () => "Tab B" });

describe("executeAutomationCommand", () => {
  describe("list_tabs", () => {
    it("returns registered tabs with url/title/active data", () => {
      const registry = createRegistry({
        listRegisteredBrowserIds: () => ["a", "b"],
        getTabContents: (id) => {
          if (id === "a") return TAB_A;
          if (id === "b") return TAB_B;
          return null;
        },
        getBrowserWorkspaceId: (id) => (id === "a" || id === "b" ? "workspace-a" : null),
        getWorkspaceActiveBrowserId: () => "a",
      });

      const result = executeAutomationCommand(
        {
          type: "browser.automation.execute.request",
          requestId: "r1",
          command: { command: "list_tabs", args: {} },
        },
        registry,
      );

      expect(result).toEqual({
        requestId: "r1",
        ok: true,
        result: {
          command: "list_tabs",
          tabs: [
            {
              browserId: "a",
              workspaceId: "workspace-a",
              url: "https://a.com",
              title: "Tab A",
              isActive: false,
              isLoading: false,
              canGoBack: false,
              canGoForward: false,
            },
            {
              browserId: "b",
              workspaceId: "workspace-a",
              url: "https://b.com",
              title: "Tab B",
              isActive: false,
              isLoading: false,
              canGoBack: false,
              canGoForward: false,
            },
          ],
        },
      });
    });

    it("skips destroyed tabs", () => {
      const destroyedTab = fakeTab({ id: 3, isDestroyed: () => true });
      const registry = createRegistry({
        listRegisteredBrowserIds: () => ["a", "dead"],
        getTabContents: (id) => {
          if (id === "a") return TAB_A;
          if (id === "dead") return destroyedTab;
          return null;
        },
      });

      const result = executeAutomationCommand(
        {
          type: "browser.automation.execute.request",
          requestId: "r2",
          command: { command: "list_tabs", args: {} },
        },
        registry,
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected success");
      expect(result.result.command).toBe("list_tabs");
      expect(result.result.tabs).toHaveLength(1);
      expect(result.result.tabs[0]?.browserId).toBe("a");
    });

    it("returns empty list when no tabs registered", () => {
      const registry = createRegistry();

      const result = executeAutomationCommand(
        {
          type: "browser.automation.execute.request",
          requestId: "r3",
          command: { command: "list_tabs", args: {} },
        },
        registry,
      );

      expect(result).toEqual({
        requestId: "r3",
        ok: true,
        result: { command: "list_tabs", tabs: [] },
      });
    });

    it("lists only tabs owned by the requested workspace", () => {
      const registry = createRegistry({
        listRegisteredBrowserIdsForWorkspace: (workspaceId) => {
          if (workspaceId === "workspace-a") return ["a"];
          if (workspaceId === "workspace-b") return ["b"];
          return [];
        },
        getTabContents: (id) => {
          if (id === "a") return TAB_A;
          if (id === "b") return TAB_B;
          return null;
        },
        getBrowserWorkspaceId: (id) => {
          if (id === "a") return "workspace-a";
          if (id === "b") return "workspace-b";
          return null;
        },
        getWorkspaceActiveBrowserId: (workspaceId) => (workspaceId === "workspace-a" ? "a" : "b"),
      });

      const result = executeAutomationCommand(
        {
          type: "browser.automation.execute.request",
          requestId: "r-workspace-list",
          workspaceId: "workspace-a",
          command: { command: "list_tabs", args: { workspaceId: "workspace-a" } },
        },
        registry,
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected success");
      expect(result.result.command).toBe("list_tabs");
      expect(result.result.tabs).toHaveLength(1);
      expect(result.result.tabs[0]?.browserId).toBe("a");
      expect(result.result.tabs[0]?.workspaceId).toBe("workspace-a");
    });
  });

  describe("page_info", () => {
    it("uses explicit browserId", () => {
      const registry = createRegistry({
        getTabContents: (id) => (id === "b" ? TAB_B : null),
      });

      const result = executeAutomationCommand(
        {
          type: "browser.automation.execute.request",
          requestId: "r4",
          browserId: "b",
          command: { command: "page_info", args: { browserId: "b" } },
        },
        registry,
      );

      expect(result).toEqual({
        requestId: "r4",
        ok: true,
        result: {
          command: "page_info",
          tab: {
            browserId: "b",
            url: "https://b.com",
            title: "Tab B",
            isActive: false,
            isLoading: false,
            canGoBack: false,
            canGoForward: false,
          },
        },
      });
    });

    it("uses the top-level browserId when command args omit it", () => {
      const registry = createRegistry({
        getTabContents: (id) => (id === "b" ? TAB_B : null),
      });

      const result = executeAutomationCommand(
        {
          type: "browser.automation.execute.request",
          requestId: "r-top-level-browser-id",
          browserId: "b",
          command: { command: "page_info", args: {} },
        },
        registry,
      );

      expect(result).toEqual({
        requestId: "r-top-level-browser-id",
        ok: true,
        result: {
          command: "page_info",
          tab: {
            browserId: "b",
            url: "https://b.com",
            title: "Tab B",
            isActive: false,
            isLoading: false,
            canGoBack: false,
            canGoForward: false,
          },
        },
      });
    });

    it("uses active workspace browser when browserId omitted", () => {
      const registry = createRegistry({
        getWorkspaceActiveTabContents: (workspaceId) =>
          workspaceId === "workspace-a" ? TAB_A : null,
        getWorkspaceActiveBrowserId: (workspaceId) => (workspaceId === "workspace-a" ? "a" : null),
        getBrowserWorkspaceId: (id) => (id === "a" ? "workspace-a" : null),
      });

      const result = executeAutomationCommand(
        {
          type: "browser.automation.execute.request",
          requestId: "r5",
          workspaceId: "workspace-a",
          command: { command: "page_info", args: { workspaceId: "workspace-a" } },
        },
        registry,
      );

      expect(result).toEqual({
        requestId: "r5",
        ok: true,
        result: {
          command: "page_info",
          tab: {
            browserId: "a",
            workspaceId: "workspace-a",
            url: "https://a.com",
            title: "Tab A",
            isActive: true,
            isLoading: false,
            canGoBack: false,
            canGoForward: false,
          },
        },
      });
    });

    it("uses the agent active browser before the human-focused workspace browser", () => {
      const registry = createRegistry({
        getTabContents: (id) => {
          if (id === "agent-browser") return TAB_B;
          if (id === "human-browser") return TAB_A;
          return null;
        },
        getBrowserWorkspaceId: (id) =>
          id === "agent-browser" || id === "human-browser" ? "workspace-a" : null,
        getWorkspaceActiveTabContents: (workspaceId) =>
          workspaceId === "workspace-a" ? TAB_A : null,
        getWorkspaceActiveBrowserId: (workspaceId) =>
          workspaceId === "workspace-a" ? "human-browser" : null,
        getAgentActiveBrowserId: (agentId) => (agentId === "agent-1" ? "agent-browser" : null),
      });

      const result = executeAutomationCommand(
        {
          type: "browser.automation.execute.request",
          requestId: "r-agent-active",
          agentId: "agent-1",
          workspaceId: "workspace-a",
          command: { command: "page_info", args: { workspaceId: "workspace-a" } },
        },
        registry,
      );

      expect(result).toEqual({
        requestId: "r-agent-active",
        ok: true,
        result: {
          command: "page_info",
          tab: {
            browserId: "agent-browser",
            workspaceId: "workspace-a",
            url: "https://b.com",
            title: "Tab B",
            isActive: false,
            isLoading: false,
            canGoBack: false,
            canGoForward: false,
          },
        },
      });
    });

    it("returns canGoBack/canGoForward when available", () => {
      const tabWithNav = fakeTab({
        id: 10,
        canGoBack: () => true,
        canGoForward: () => true,
      });
      const registry = createRegistry({
        getTabContents: () => tabWithNav,
      });

      const result = executeAutomationCommand(
        {
          type: "browser.automation.execute.request",
          requestId: "r-nav",
          browserId: "x",
          command: { command: "page_info", args: { browserId: "x" } },
        },
        registry,
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected success");
      expect(result.result.command).toBe("page_info");
      expect(result.result.tab.canGoBack).toBe(true);
      expect(result.result.tab.canGoForward).toBe(true);
    });

    it("returns browser_no_tab when no active workspace browser", () => {
      const registry = createRegistry({
        getWorkspaceActiveTabContents: () => null,
        getWorkspaceActiveBrowserId: () => null,
      });

      const result = executeAutomationCommand(
        {
          type: "browser.automation.execute.request",
          requestId: "r6",
          command: { command: "page_info", args: {} },
        },
        registry,
      );

      expect(result).toEqual({
        requestId: "r6",
        ok: false,
        error: {
          code: "browser_no_tab",
          message: "No active browser tab in workspace",
          retryable: false,
        },
      });
    });

    it("returns browser_tab_not_found for missing explicit browserId", () => {
      const registry = createRegistry({ getTabContents: () => null });

      const result = executeAutomationCommand(
        {
          type: "browser.automation.execute.request",
          requestId: "r7",
          browserId: "missing",
          command: { command: "page_info", args: { browserId: "missing" } },
        },
        registry,
      );

      expect(result).toEqual({
        requestId: "r7",
        ok: false,
        error: {
          code: "browser_tab_not_found",
          message: "No browser tab found for ID: missing",
          retryable: false,
        },
      });
    });

    it("returns browser_tab_not_found when explicit browserId belongs to another workspace", () => {
      const registry = createRegistry({
        getTabContents: (id) => (id === "b" ? TAB_B : null),
        getBrowserWorkspaceId: (id) => (id === "b" ? "workspace-b" : null),
      });

      const result = executeAutomationCommand(
        {
          type: "browser.automation.execute.request",
          requestId: "r-cross-workspace-browser-id",
          workspaceId: "workspace-a",
          browserId: "b",
          command: {
            command: "page_info",
            args: { workspaceId: "workspace-a", browserId: "b" },
          },
        },
        registry,
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.error.code).toBe("browser_tab_not_found");
    });

    it("returns browser_tab_closed for destroyed tab", () => {
      const destroyedTab = fakeTab({ id: 99, isDestroyed: () => true });
      const registry = createRegistry({
        getTabContents: () => destroyedTab,
      });

      const result = executeAutomationCommand(
        {
          type: "browser.automation.execute.request",
          requestId: "r8",
          browserId: "dead",
          command: { command: "page_info", args: { browserId: "dead" } },
        },
        registry,
      );

      expect(result).toEqual({
        requestId: "r8",
        ok: false,
        error: {
          code: "browser_tab_closed",
          message: "Browser tab dead has been closed",
          retryable: false,
        },
      });
    });

    it("returns browser_tab_closed for destroyed active workspace tab", () => {
      const destroyedTab = fakeTab({ id: 99, isDestroyed: () => true });
      const registry = createRegistry({
        getWorkspaceActiveTabContents: (workspaceId) =>
          workspaceId === "workspace-a" ? destroyedTab : null,
        getWorkspaceActiveBrowserId: (workspaceId) =>
          workspaceId === "workspace-a" ? "dead" : null,
      });

      const result = executeAutomationCommand(
        {
          type: "browser.automation.execute.request",
          requestId: "r-active-dead",
          workspaceId: "workspace-a",
          command: { command: "page_info", args: { workspaceId: "workspace-a" } },
        },
        registry,
      );

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("expected failure");
      expect(result.error.code).toBe("browser_tab_closed");
    });
  });

  describe("set_background", () => {
    it("sets the active tab page background color", async () => {
      const scripts: string[] = [];
      const tab = fakeTab({
        id: 99,
        executeJavaScript: async (script) => {
          scripts.push(script);
          return true;
        },
      });
      const registry = createRegistry({
        getWorkspaceActiveTabContents: () => tab,
        getWorkspaceActiveBrowserId: () => "browser-1",
      });

      const result = await executeAutomationCommand(
        {
          type: "browser.automation.execute.request",
          requestId: "r-bg",
          workspaceId: "workspace-a",
          command: {
            command: "set_background",
            args: { workspaceId: "workspace-a", color: "red" },
          },
        },
        registry,
      );

      expect(result).toEqual({
        requestId: "r-bg",
        ok: true,
        result: { command: "set_background", browserId: "browser-1", color: "red" },
      });
      expect(hasScriptWith(scripts, "document.body.style.background", "red")).toBe(true);
    });
  });

  describe("snapshot", () => {
    it("returns snapshot refs for the active workspace browser", async () => {
      const tab = fakeTab({
        id: 5,
        getURL: () => "https://example.com/form",
        getTitle: () => "Fixture",
        executeJavaScript: async () =>
          JSON.stringify([
            {
              role: "textbox",
              tagName: "input",
              text: "Name",
              selector: "#name",
              attributes: { id: "name", type: "text" },
            },
            {
              role: "button",
              tagName: "button",
              text: "Greet",
              selector: "button",
              attributes: {},
            },
          ]),
      });
      const registry = createRegistry({
        getWorkspaceActiveTabContents: (workspaceId) =>
          workspaceId === "workspace-a" ? tab : null,
        getWorkspaceActiveBrowserId: (workspaceId) => (workspaceId === "workspace-a" ? "a" : null),
        getBrowserWorkspaceId: (id) => (id === "a" ? "workspace-a" : null),
      });

      const result = await executeAutomationCommand(
        {
          type: "browser.automation.execute.request",
          requestId: "r-snapshot",
          workspaceId: "workspace-a",
          command: { command: "snapshot", args: { workspaceId: "workspace-a" } },
        },
        registry,
      );

      expect(result).toEqual({
        requestId: "r-snapshot",
        ok: true,
        result: {
          command: "snapshot",
          browserId: "a",
          workspaceId: "workspace-a",
          url: "https://example.com/form",
          title: "Fixture",
          elements: [
            {
              ref: "@e1",
              role: "textbox",
              tagName: "input",
              text: "Name",
              selector: "#name",
              attributes: { id: "name", type: "text" },
            },
            {
              ref: "@e2",
              role: "button",
              tagName: "button",
              text: "Greet",
              selector: "button",
              attributes: {},
            },
          ],
        },
      });
    });
  });

  describe("click and fill", () => {
    it("fills and clicks refs from the latest snapshot", async () => {
      const executedScripts: string[] = [];
      const tab = fakeTab({
        id: 6,
        getURL: () => "https://example.com/form",
        getTitle: () => "Fixture",
        executeJavaScript: async (script) => {
          executedScripts.push(script);
          if (script.includes("CANDIDATE_SELECTOR")) {
            return JSON.stringify([
              {
                role: "textbox",
                tagName: "input",
                text: "Name",
                selector: "#name",
                attributes: { id: "name", type: "text" },
              },
              {
                role: "button",
                tagName: "button",
                text: "Greet",
                selector: "#greet",
                attributes: { id: "greet" },
              },
            ]);
          }
          return true;
        },
      });
      const registry = createRegistry({
        getWorkspaceActiveTabContents: (workspaceId) =>
          workspaceId === "workspace-a" ? tab : null,
        getWorkspaceActiveBrowserId: (workspaceId) => (workspaceId === "workspace-a" ? "a" : null),
        getBrowserWorkspaceId: (id) => (id === "a" ? "workspace-a" : null),
      });

      await executeAutomationCommand(
        {
          type: "browser.automation.execute.request",
          requestId: "r-snapshot-for-actions",
          workspaceId: "workspace-a",
          command: { command: "snapshot", args: { workspaceId: "workspace-a" } },
        },
        registry,
      );

      const fillResult = await executeAutomationCommand(
        {
          type: "browser.automation.execute.request",
          requestId: "r-fill",
          workspaceId: "workspace-a",
          command: {
            command: "fill",
            args: { workspaceId: "workspace-a", ref: "@e1", value: "Ada" },
          },
        },
        registry,
      );
      const clickResult = await executeAutomationCommand(
        {
          type: "browser.automation.execute.request",
          requestId: "r-click",
          workspaceId: "workspace-a",
          command: { command: "click", args: { workspaceId: "workspace-a", ref: "@e2" } },
        },
        registry,
      );

      expect(fillResult).toEqual({
        requestId: "r-fill",
        ok: true,
        result: { command: "fill", browserId: "a", ref: "@e1" },
      });
      expect(clickResult).toEqual({
        requestId: "r-click",
        ok: true,
        result: { command: "click", browserId: "a", ref: "@e2" },
      });
      let filledName = false;
      let clickedGreet = false;
      for (const script of executedScripts) {
        filledName ||= script.includes("#name") && script.includes("Ada");
        clickedGreet ||= script.includes("#greet") && script.includes("click");
      }
      expect(filledName).toBe(true);
      expect(clickedGreet).toBe(true);
    });

    it("returns browser_stale_ref when the page has navigated since the snapshot", async () => {
      let currentUrl = "https://example.com/form";
      const tab = fakeTab({
        id: 7,
        getURL: () => currentUrl,
        executeJavaScript: async () =>
          JSON.stringify([
            {
              role: "button",
              tagName: "button",
              text: "Greet",
              selector: "#greet",
              attributes: { id: "greet" },
            },
          ]),
      });
      const registry = createRegistry({
        getWorkspaceActiveTabContents: (workspaceId) =>
          workspaceId === "workspace-a" ? tab : null,
        getWorkspaceActiveBrowserId: (workspaceId) => (workspaceId === "workspace-a" ? "a" : null),
        getBrowserWorkspaceId: (id) => (id === "a" ? "workspace-a" : null),
      });

      await executeAutomationCommand(
        {
          type: "browser.automation.execute.request",
          requestId: "r-snapshot-before-nav",
          workspaceId: "workspace-a",
          command: { command: "snapshot", args: { workspaceId: "workspace-a" } },
        },
        registry,
      );
      currentUrl = "https://example.com/next";

      const result = await executeAutomationCommand(
        {
          type: "browser.automation.execute.request",
          requestId: "r-stale-click",
          workspaceId: "workspace-a",
          command: { command: "click", args: { workspaceId: "workspace-a", ref: "@e1" } },
        },
        registry,
      );

      expect(result).toEqual({
        requestId: "r-stale-click",
        ok: false,
        error: {
          code: "browser_stale_ref",
          message: "Browser element reference @e1 is stale. Take a new snapshot and try again.",
          retryable: false,
        },
      });
    });

    it("returns browser_stale_ref when a same-URL DOM change removes the ref", async () => {
      const tab = fakeTab({
        id: 26,
        getURL: () => "https://example.com/form",
        executeJavaScript: async (script) => {
          if (script.includes("CANDIDATE_SELECTOR")) {
            return JSON.stringify([
              {
                role: "button",
                tagName: "button",
                text: "Greet",
                selector: "#greet",
                attributes: { id: "greet" },
              },
            ]);
          }
          return false;
        },
      });
      const registry = createRegistry({
        getWorkspaceActiveTabContents: (workspaceId) =>
          workspaceId === "workspace-a" ? tab : null,
        getWorkspaceActiveBrowserId: (workspaceId) => (workspaceId === "workspace-a" ? "a" : null),
        getBrowserWorkspaceId: (id) => (id === "a" ? "workspace-a" : null),
      });

      await executeAutomationCommand(
        {
          type: "browser.automation.execute.request",
          requestId: "r-snapshot-before-dom-removal",
          workspaceId: "workspace-a",
          command: { command: "snapshot", args: { workspaceId: "workspace-a" } },
        },
        registry,
      );

      const result = await executeAutomationCommand(
        {
          type: "browser.automation.execute.request",
          requestId: "r-dom-removed-click",
          workspaceId: "workspace-a",
          command: { command: "click", args: { workspaceId: "workspace-a", ref: "@e1" } },
        },
        registry,
      );

      expect(result).toEqual({
        requestId: "r-dom-removed-click",
        ok: false,
        error: {
          code: "browser_stale_ref",
          message: "Browser element reference @e1 is stale. Take a new snapshot and try again.",
          retryable: false,
        },
      });
    });

    it("focuses, clears, checks, and selects snapshot refs", async () => {
      const executedScripts: string[] = [];
      const tab = fakeTab({
        id: 17,
        getURL: () => "https://example.com/controls",
        executeJavaScript: async (script) => {
          executedScripts.push(script);
          if (script.includes("CANDIDATE_SELECTOR")) {
            return JSON.stringify([
              {
                role: "textbox",
                tagName: "input",
                text: "Name",
                selector: "#name",
                attributes: { id: "name", type: "text" },
              },
              {
                role: "checkbox",
                tagName: "input",
                text: "Subscribe",
                selector: "#subscribe",
                attributes: { id: "subscribe", type: "checkbox" },
              },
              {
                role: "combobox",
                tagName: "select",
                text: "Country",
                selector: "#country",
                attributes: { id: "country" },
              },
              {
                role: "button",
                tagName: "button",
                text: "Preview",
                selector: "#preview",
                attributes: { id: "preview" },
              },
              {
                role: "generic",
                tagName: "div",
                text: "Drop zone",
                selector: "#drop-zone",
                attributes: { id: "drop-zone", tabindex: "0" },
              },
            ]);
          }
          return true;
        },
      });
      const registry = createRegistry({
        getWorkspaceActiveTabContents: (workspaceId) =>
          workspaceId === "workspace-a" ? tab : null,
        getWorkspaceActiveBrowserId: (workspaceId) => (workspaceId === "workspace-a" ? "a" : null),
        getBrowserWorkspaceId: (id) => (id === "a" ? "workspace-a" : null),
      });

      await executeAutomationCommand(
        {
          type: "browser.automation.execute.request",
          requestId: "r-snapshot-for-controls",
          workspaceId: "workspace-a",
          command: { command: "snapshot", args: { workspaceId: "workspace-a" } },
        },
        registry,
      );

      const focusResult = await executeAutomationCommand(
        {
          type: "browser.automation.execute.request",
          requestId: "r-focus",
          workspaceId: "workspace-a",
          command: { command: "focus", args: { workspaceId: "workspace-a", ref: "@e1" } },
        },
        registry,
      );
      const clearResult = await executeAutomationCommand(
        {
          type: "browser.automation.execute.request",
          requestId: "r-clear",
          workspaceId: "workspace-a",
          command: { command: "clear", args: { workspaceId: "workspace-a", ref: "@e1" } },
        },
        registry,
      );
      const checkResult = await executeAutomationCommand(
        {
          type: "browser.automation.execute.request",
          requestId: "r-check",
          workspaceId: "workspace-a",
          command: {
            command: "check",
            args: { workspaceId: "workspace-a", ref: "@e2", checked: true },
          },
        },
        registry,
      );
      const selectResult = await executeAutomationCommand(
        {
          type: "browser.automation.execute.request",
          requestId: "r-select",
          workspaceId: "workspace-a",
          command: {
            command: "select",
            args: { workspaceId: "workspace-a", ref: "@e3", value: "us" },
          },
        },
        registry,
      );
      const hoverResult = await executeAutomationCommand(
        {
          type: "browser.automation.execute.request",
          requestId: "r-hover",
          workspaceId: "workspace-a",
          command: { command: "hover", args: { workspaceId: "workspace-a", ref: "@e4" } },
        },
        registry,
      );
      const dragResult = await executeAutomationCommand(
        {
          type: "browser.automation.execute.request",
          requestId: "r-drag",
          workspaceId: "workspace-a",
          command: {
            command: "drag",
            args: { workspaceId: "workspace-a", sourceRef: "@e4", targetRef: "@e5" },
          },
        },
        registry,
      );

      expect(focusResult).toEqual({
        requestId: "r-focus",
        ok: true,
        result: { command: "focus", browserId: "a", ref: "@e1" },
      });
      expect(clearResult).toEqual({
        requestId: "r-clear",
        ok: true,
        result: { command: "clear", browserId: "a", ref: "@e1" },
      });
      expect(checkResult).toEqual({
        requestId: "r-check",
        ok: true,
        result: { command: "check", browserId: "a", ref: "@e2", checked: true },
      });
      expect(selectResult).toEqual({
        requestId: "r-select",
        ok: true,
        result: { command: "select", browserId: "a", ref: "@e3", value: "us" },
      });
      expect(hoverResult).toEqual({
        requestId: "r-hover",
        ok: true,
        result: { command: "hover", browserId: "a", ref: "@e4" },
      });
      expect(dragResult).toEqual({
        requestId: "r-drag",
        ok: true,
        result: { command: "drag", browserId: "a", sourceRef: "@e4", targetRef: "@e5" },
      });
      expect(hasScriptWith(executedScripts, "#name", "focus")).toBe(true);
      expect(hasScriptWith(executedScripts, "#name", "deleteContent")).toBe(true);
      expect(hasScriptWith(executedScripts, "#subscribe", "checked")).toBe(true);
      expect(hasScriptWith(executedScripts, "#country", "us")).toBe(true);
      expect(hasScriptWith(executedScripts, "#preview", "mouseover")).toBe(true);
      expect(hasScriptWith(executedScripts, "#drop-zone", "dragover")).toBe(true);
    });
  });

  describe("wait", () => {
    it("waits until page text appears", async () => {
      let reads = 0;
      const tab = fakeTab({
        id: 8,
        getURL: () => "https://example.com/wait",
        executeJavaScript: async () => {
          reads += 1;
          return reads >= 2 ? "Loading\nReady" : "Loading";
        },
      });
      const registry = createRegistry({
        getWorkspaceActiveTabContents: (workspaceId) =>
          workspaceId === "workspace-a" ? tab : null,
        getWorkspaceActiveBrowserId: (workspaceId) => (workspaceId === "workspace-a" ? "a" : null),
        getBrowserWorkspaceId: (id) => (id === "a" ? "workspace-a" : null),
      });

      const result = await executeAutomationCommand(
        {
          type: "browser.automation.execute.request",
          requestId: "r-wait-text",
          workspaceId: "workspace-a",
          command: {
            command: "wait",
            args: { workspaceId: "workspace-a", text: "Ready", timeoutMs: 100 },
          },
        },
        registry,
      );

      expect(result).toEqual({
        requestId: "r-wait-text",
        ok: true,
        result: { command: "wait", browserId: "a", matched: "text" },
      });
    });

    it("returns browser_timeout when waited-for text does not appear", async () => {
      const tab = fakeTab({
        id: 9,
        getURL: () => "https://example.com/wait",
        executeJavaScript: async () => "Loading",
      });
      const registry = createRegistry({
        getWorkspaceActiveTabContents: (workspaceId) =>
          workspaceId === "workspace-a" ? tab : null,
        getWorkspaceActiveBrowserId: (workspaceId) => (workspaceId === "workspace-a" ? "a" : null),
        getBrowserWorkspaceId: (id) => (id === "a" ? "workspace-a" : null),
      });

      const result = await executeAutomationCommand(
        {
          type: "browser.automation.execute.request",
          requestId: "r-wait-timeout",
          workspaceId: "workspace-a",
          command: {
            command: "wait",
            args: { workspaceId: "workspace-a", text: "Ready", timeoutMs: 1 },
          },
        },
        registry,
      );

      expect(result).toEqual({
        requestId: "r-wait-timeout",
        ok: false,
        error: {
          code: "browser_timeout",
          message: "Timed out waiting for browser text: Ready",
          retryable: true,
        },
      });
    });
  });

  describe("type and keypress", () => {
    it("types text into a snapshot ref and dispatches keypress", async () => {
      const executedScripts: string[] = [];
      const tab = fakeTab({
        id: 10,
        getURL: () => "https://example.com/type",
        executeJavaScript: async (script) => {
          executedScripts.push(script);
          if (script.includes("CANDIDATE_SELECTOR")) {
            return JSON.stringify([
              {
                role: "textbox",
                tagName: "input",
                text: "Name",
                selector: "#name",
                attributes: { id: "name" },
              },
            ]);
          }
          return true;
        },
      });
      const registry = createRegistry({
        getWorkspaceActiveTabContents: (workspaceId) =>
          workspaceId === "workspace-a" ? tab : null,
        getWorkspaceActiveBrowserId: (workspaceId) => (workspaceId === "workspace-a" ? "a" : null),
        getBrowserWorkspaceId: (id) => (id === "a" ? "workspace-a" : null),
      });

      await executeAutomationCommand(
        {
          type: "browser.automation.execute.request",
          requestId: "r-snapshot-for-type",
          workspaceId: "workspace-a",
          command: { command: "snapshot", args: { workspaceId: "workspace-a" } },
        },
        registry,
      );

      const typeResult = await executeAutomationCommand(
        {
          type: "browser.automation.execute.request",
          requestId: "r-type",
          workspaceId: "workspace-a",
          command: {
            command: "type",
            args: { workspaceId: "workspace-a", ref: "@e1", text: "Ada" },
          },
        },
        registry,
      );
      const keyResult = await executeAutomationCommand(
        {
          type: "browser.automation.execute.request",
          requestId: "r-keypress",
          workspaceId: "workspace-a",
          command: {
            command: "keypress",
            args: { workspaceId: "workspace-a", ref: "@e1", key: "Enter" },
          },
        },
        registry,
      );

      expect(typeResult).toEqual({
        requestId: "r-type",
        ok: true,
        result: { command: "type", browserId: "a", ref: "@e1" },
      });
      expect(keyResult).toEqual({
        requestId: "r-keypress",
        ok: true,
        result: { command: "keypress", browserId: "a", key: "Enter", ref: "@e1" },
      });
      let typedAda = false;
      let pressedEnter = false;
      for (const script of executedScripts) {
        typedAda ||= script.includes("#name") && script.includes("Ada");
        pressedEnter ||= script.includes("#name") && script.includes("Enter");
      }
      expect(typedAda).toBe(true);
      expect(pressedEnter).toBe(true);
    });
  });

  describe("logs", () => {
    it("returns recent console messages and network performance entries", async () => {
      const tab = fakeTab({
        id: 19,
        getConsoleMessages: () => [
          { level: "info", message: "first", timestamp: 1 },
          { level: "error", message: "second", source: "fixture", line: 7, timestamp: 2 },
        ],
        executeJavaScript: async () =>
          JSON.stringify([
            {
              url: "https://example.com/app.js",
              type: "script",
              startTime: 3,
              duration: 4,
              transferSize: 100,
            },
          ]),
      });
      const registry = createRegistry({
        getWorkspaceActiveTabContents: (workspaceId) =>
          workspaceId === "workspace-a" ? tab : null,
        getWorkspaceActiveBrowserId: (workspaceId) => (workspaceId === "workspace-a" ? "a" : null),
        getBrowserWorkspaceId: (id) => (id === "a" ? "workspace-a" : null),
      });

      const result = await executeAutomationCommand(
        {
          type: "browser.automation.execute.request",
          requestId: "r-logs",
          workspaceId: "workspace-a",
          command: { command: "logs", args: { workspaceId: "workspace-a", maxEntries: 1 } },
        },
        registry,
      );

      expect(result).toEqual({
        requestId: "r-logs",
        ok: true,
        result: {
          command: "logs",
          browserId: "a",
          console: [
            { level: "error", message: "second", source: "fixture", line: 7, timestamp: 2 },
          ],
          network: [
            {
              url: "https://example.com/app.js",
              type: "script",
              startTime: 3,
              duration: 4,
              transferSize: 100,
            },
          ],
        },
      });
    });
  });

  describe("storage", () => {
    it("returns cookies, localStorage, and sessionStorage for the target tab", async () => {
      const tab = fakeTab({
        id: 20,
        getURL: () => "https://example.com/storage",
        getCookies: async () => [
          { name: "theme", value: "dark", domain: "example.com", httpOnly: true },
        ],
        executeJavaScript: async () =>
          JSON.stringify({
            localStorage: [{ key: "token", value: "abc" }],
            sessionStorage: [{ key: "tab", value: "1" }],
          }),
      });
      const registry = createRegistry({
        getWorkspaceActiveTabContents: (workspaceId) =>
          workspaceId === "workspace-a" ? tab : null,
        getWorkspaceActiveBrowserId: (workspaceId) => (workspaceId === "workspace-a" ? "a" : null),
        getBrowserWorkspaceId: (id) => (id === "a" ? "workspace-a" : null),
      });

      const result = await executeAutomationCommand(
        {
          type: "browser.automation.execute.request",
          requestId: "r-storage",
          workspaceId: "workspace-a",
          command: { command: "storage", args: { workspaceId: "workspace-a" } },
        },
        registry,
      );

      expect(result).toEqual({
        requestId: "r-storage",
        ok: true,
        result: {
          command: "storage",
          browserId: "a",
          url: "https://example.com/storage",
          cookies: [{ name: "theme", value: "dark", domain: "example.com", httpOnly: true }],
          localStorage: [{ key: "token", value: "abc" }],
          sessionStorage: [{ key: "tab", value: "1" }],
        },
      });
    });
  });

  describe("environment", () => {
    it("sets viewport and geolocation for the target tab", async () => {
      const debugCommands: Array<{ command: string; params?: Record<string, unknown> }> = [];
      const scripts: string[] = [];
      const tab = fakeTab({
        id: 21,
        sendDebugCommand: async (command, params) => {
          debugCommands.push({ command, params });
        },
        executeJavaScript: async (script) => {
          scripts.push(script);
          if (script.includes("window.innerWidth")) {
            return JSON.stringify({ width: 390, height: 844, deviceScaleFactor: 3 });
          }
          return true;
        },
      });
      const registry = createRegistry({
        getWorkspaceActiveTabContents: (workspaceId) =>
          workspaceId === "workspace-a" ? tab : null,
        getWorkspaceActiveBrowserId: (workspaceId) => (workspaceId === "workspace-a" ? "a" : null),
        getBrowserWorkspaceId: (id) => (id === "a" ? "workspace-a" : null),
      });

      const result = await executeAutomationCommand(
        {
          type: "browser.automation.execute.request",
          requestId: "r-environment",
          workspaceId: "workspace-a",
          command: {
            command: "environment",
            args: {
              workspaceId: "workspace-a",
              viewport: { width: 390, height: 844, deviceScaleFactor: 3 },
              geolocation: { latitude: 37.7749, longitude: -122.4194, accuracy: 5 },
            },
          },
        },
        registry,
      );

      expect(debugCommands).toEqual([
        {
          command: "Emulation.setDeviceMetricsOverride",
          params: { width: 390, height: 844, deviceScaleFactor: 3, mobile: false },
        },
        {
          command: "Emulation.setGeolocationOverride",
          params: { latitude: 37.7749, longitude: -122.4194, accuracy: 5 },
        },
      ]);
      expect(hasScriptWith(scripts, "navigator", "geolocation")).toBe(true);
      expect(result).toEqual({
        requestId: "r-environment",
        ok: true,
        result: {
          command: "environment",
          browserId: "a",
          viewport: { width: 390, height: 844, deviceScaleFactor: 3 },
          geolocation: { latitude: 37.7749, longitude: -122.4194, accuracy: 5 },
        },
      });
    });
  });

  describe("full-page screenshot and PDF", () => {
    it("captures a full-page screenshot through CDP", async () => {
      const debugCommands: Array<{ command: string; params?: Record<string, unknown> }> = [];
      const tab = fakeTab({
        id: 22,
        sendDebugCommand: async (command, params) => {
          debugCommands.push({ command, params });
          if (command === "Page.getLayoutMetrics") {
            return { contentSize: { width: 390.2, height: 1200.1 } };
          }
          return { data: "iVBORw0KGgo=" };
        },
      });
      const registry = createRegistry({
        getWorkspaceActiveTabContents: (workspaceId) =>
          workspaceId === "workspace-a" ? tab : null,
        getWorkspaceActiveBrowserId: (workspaceId) => (workspaceId === "workspace-a" ? "a" : null),
        getBrowserWorkspaceId: (id) => (id === "a" ? "workspace-a" : null),
      });

      const result = await executeAutomationCommand(
        {
          type: "browser.automation.execute.request",
          requestId: "r-full-page",
          workspaceId: "workspace-a",
          command: { command: "full_page_screenshot", args: { workspaceId: "workspace-a" } },
        },
        registry,
      );

      expect(debugCommands).toEqual([
        { command: "Page.getLayoutMetrics", params: undefined },
        {
          command: "Page.captureScreenshot",
          params: {
            format: "png",
            captureBeyondViewport: true,
            clip: { x: 0, y: 0, width: 391, height: 1201, scale: 1 },
          },
        },
      ]);
      expect(result).toEqual({
        requestId: "r-full-page",
        ok: true,
        result: {
          command: "full_page_screenshot",
          browserId: "a",
          mimeType: "image/png",
          dataBase64: "iVBORw0KGgo=",
          width: 391,
          height: 1201,
        },
      });
    });

    it("exports the target tab as PDF", async () => {
      const printOptions: Record<string, unknown>[] = [];
      const tab = fakeTab({
        id: 23,
        printToPDF: async (options) => {
          printOptions.push(options ?? {});
          return new Uint8Array([0x25, 0x50, 0x44, 0x46]);
        },
      });
      const registry = createRegistry({
        getWorkspaceActiveTabContents: (workspaceId) =>
          workspaceId === "workspace-a" ? tab : null,
        getWorkspaceActiveBrowserId: (workspaceId) => (workspaceId === "workspace-a" ? "a" : null),
        getBrowserWorkspaceId: (id) => (id === "a" ? "workspace-a" : null),
      });

      const result = await executeAutomationCommand(
        {
          type: "browser.automation.execute.request",
          requestId: "r-pdf",
          workspaceId: "workspace-a",
          command: {
            command: "pdf",
            args: { workspaceId: "workspace-a", landscape: true, printBackground: false },
          },
        },
        registry,
      );

      expect(printOptions).toEqual([{ printBackground: false, landscape: true }]);
      expect(result).toEqual({
        requestId: "r-pdf",
        ok: true,
        result: {
          command: "pdf",
          browserId: "a",
          mimeType: "application/pdf",
          dataBase64: "JVBERg==",
        },
      });
    });
  });

  describe("download and upload", () => {
    it("downloads a URL through the target tab", async () => {
      const tab = fakeTab({
        id: 24,
        downloadURL: async (input) => ({
          filePath: `/tmp/${input.fileName ?? "download"}`,
          totalBytes: 5,
          state: "completed",
        }),
      });
      const registry = createRegistry({
        getWorkspaceActiveTabContents: (workspaceId) =>
          workspaceId === "workspace-a" ? tab : null,
        getWorkspaceActiveBrowserId: (workspaceId) => (workspaceId === "workspace-a" ? "a" : null),
        getBrowserWorkspaceId: (id) => (id === "a" ? "workspace-a" : null),
      });

      const result = await executeAutomationCommand(
        {
          type: "browser.automation.execute.request",
          requestId: "r-download",
          workspaceId: "workspace-a",
          command: {
            command: "download",
            args: {
              workspaceId: "workspace-a",
              url: "https://example.com/file.txt",
              fileName: "file.txt",
            },
          },
        },
        registry,
      );

      expect(result).toEqual({
        requestId: "r-download",
        ok: true,
        result: {
          command: "download",
          browserId: "a",
          url: "https://example.com/file.txt",
          filePath: "/tmp/file.txt",
          totalBytes: 5,
          state: "completed",
        },
      });
    });

    it("rejects downloads for non-http URLs", async () => {
      const downloadedUrls: string[] = [];
      const tab = fakeTab({
        id: 27,
        downloadURL: async (input) => {
          downloadedUrls.push(input.url);
          return { filePath: "/tmp/download", state: "completed" };
        },
      });
      const registry = createRegistry({
        getWorkspaceActiveTabContents: (workspaceId) =>
          workspaceId === "workspace-a" ? tab : null,
        getWorkspaceActiveBrowserId: (workspaceId) => (workspaceId === "workspace-a" ? "a" : null),
        getBrowserWorkspaceId: (id) => (id === "a" ? "workspace-a" : null),
      });

      const result = await executeAutomationCommand(
        {
          type: "browser.automation.execute.request",
          requestId: "r-download-file",
          workspaceId: "workspace-a",
          command: {
            command: "download",
            args: { workspaceId: "workspace-a", url: "file:///tmp/secret.txt" },
          },
        },
        registry,
      );

      expect(downloadedUrls).toEqual([]);
      expect(result).toEqual({
        requestId: "r-download-file",
        ok: false,
        error: {
          code: "browser_denied",
          message: "Browser download only supports http and https URLs.",
          retryable: false,
        },
      });
    });

    it("sets workspace files on a file input ref through CDP", async () => {
      const debugCommands: Array<{ command: string; params?: Record<string, unknown> }> = [];
      const workspaceRoot = "/tmp/paseo-workspace-a";
      const tab = fakeTab({
        id: 25,
        executeJavaScript: async () =>
          JSON.stringify([
            {
              role: "textbox",
              tagName: "input",
              text: "",
              selector: "#file",
              attributes: { id: "file", type: "file" },
            },
          ]),
        sendDebugCommand: async (command, params) => {
          debugCommands.push({ command, params });
          if (command === "DOM.getDocument") {
            return { root: { nodeId: 1 } };
          }
          if (command === "DOM.querySelector") {
            return { nodeId: 2 };
          }
          return {};
        },
      });
      const registry = createRegistry({
        getWorkspaceActiveTabContents: (workspaceId) =>
          workspaceId === workspaceRoot ? tab : null,
        getWorkspaceActiveBrowserId: (workspaceId) => (workspaceId === workspaceRoot ? "a" : null),
        getBrowserWorkspaceId: (id) => (id === "a" ? workspaceRoot : null),
      });
      const snapshotEngine = new BrowserSnapshotEngine();
      const snapshot = await executeAutomationCommand(
        {
          type: "browser.automation.execute.request",
          requestId: "r-snapshot-upload",
          workspaceId: workspaceRoot,
          command: { command: "snapshot", args: { workspaceId: workspaceRoot } },
        },
        registry,
        { snapshotEngine },
      );
      if (!snapshot.ok || snapshot.result.command !== "snapshot") {
        throw new Error("snapshot failed");
      }
      const ref = snapshot.result.elements[0]?.ref;
      if (!ref) {
        throw new Error("missing upload ref");
      }
      const uploadPath = resolvePath(workspaceRoot, "uploads/file.txt");

      const result = await executeAutomationCommand(
        {
          type: "browser.automation.execute.request",
          requestId: "r-upload",
          workspaceId: workspaceRoot,
          command: {
            command: "upload",
            args: { workspaceId: workspaceRoot, ref, filePaths: ["uploads/file.txt"] },
          },
        },
        registry,
        { snapshotEngine },
      );

      expect(debugCommands.at(-1)).toEqual({
        command: "DOM.setFileInputFiles",
        params: { nodeId: 2, files: [uploadPath] },
      });
      expect(result).toEqual({
        requestId: "r-upload",
        ok: true,
        result: {
          command: "upload",
          browserId: "a",
          ref,
          filePaths: [uploadPath],
        },
      });
    });

    it("rejects upload paths outside the workspace", async () => {
      const workspaceRoot = "/tmp/paseo-workspace-a";
      const debugCommands: Array<{ command: string; params?: Record<string, unknown> }> = [];
      const tab = fakeTab({
        id: 26,
        executeJavaScript: async () =>
          JSON.stringify([
            {
              role: "textbox",
              tagName: "input",
              text: "",
              selector: "#file",
              attributes: { id: "file", type: "file" },
            },
          ]),
        sendDebugCommand: async (command, params) => {
          debugCommands.push({ command, params });
          if (command === "DOM.getDocument") {
            return { root: { nodeId: 1 } };
          }
          if (command === "DOM.querySelector") {
            return { nodeId: 2 };
          }
          return {};
        },
      });
      const registry = createRegistry({
        getWorkspaceActiveTabContents: (workspaceId) =>
          workspaceId === workspaceRoot ? tab : null,
        getWorkspaceActiveBrowserId: (workspaceId) => (workspaceId === workspaceRoot ? "a" : null),
        getBrowserWorkspaceId: (id) => (id === "a" ? workspaceRoot : null),
      });
      const snapshotEngine = new BrowserSnapshotEngine();
      const snapshot = await executeAutomationCommand(
        {
          type: "browser.automation.execute.request",
          requestId: "r-snapshot-upload-outside",
          workspaceId: workspaceRoot,
          command: { command: "snapshot", args: { workspaceId: workspaceRoot } },
        },
        registry,
        { snapshotEngine },
      );
      if (!snapshot.ok || snapshot.result.command !== "snapshot") {
        throw new Error("snapshot failed");
      }
      const ref = snapshot.result.elements[0]?.ref;
      if (!ref) {
        throw new Error("missing upload ref");
      }

      const result = await executeAutomationCommand(
        {
          type: "browser.automation.execute.request",
          requestId: "r-upload-outside",
          workspaceId: workspaceRoot,
          command: {
            command: "upload",
            args: { workspaceId: workspaceRoot, ref, filePaths: ["../secret.txt"] },
          },
        },
        registry,
        { snapshotEngine },
      );

      expect(debugCommands).not.toContainEqual(
        expect.objectContaining({ command: "DOM.setFileInputFiles" }),
      );
      expect(result).toEqual({
        requestId: "r-upload-outside",
        ok: false,
        error: {
          code: "browser_unsupported",
          message: "browser_upload only accepts files inside the agent workspace.",
          retryable: false,
        },
      });
    });
  });

  describe("navigation", () => {
    it("navigates the active workspace browser to a URL", async () => {
      const navigatedUrls: string[] = [];
      const tab = fakeTab({
        id: 11,
        loadURL: async (url) => {
          navigatedUrls.push(url);
        },
      });
      const registry = createRegistry({
        getWorkspaceActiveTabContents: (workspaceId) =>
          workspaceId === "workspace-a" ? tab : null,
        getWorkspaceActiveBrowserId: (workspaceId) => (workspaceId === "workspace-a" ? "a" : null),
        getBrowserWorkspaceId: (id) => (id === "a" ? "workspace-a" : null),
      });

      const result = await executeAutomationCommand(
        {
          type: "browser.automation.execute.request",
          requestId: "r-navigate",
          workspaceId: "workspace-a",
          command: {
            command: "navigate",
            args: { workspaceId: "workspace-a", url: "https://example.com/next" },
          },
        },
        registry,
      );

      expect(result).toEqual({
        requestId: "r-navigate",
        ok: true,
        result: { command: "navigate", browserId: "a", url: "https://example.com/next" },
      });
      expect(navigatedUrls).toEqual(["https://example.com/next"]);
    });

    it("rejects navigation to local files and script URLs", async () => {
      const navigatedUrls: string[] = [];
      const tab = fakeTab({
        id: 13,
        loadURL: async (url) => {
          navigatedUrls.push(url);
        },
      });
      const registry = createRegistry({
        getWorkspaceActiveTabContents: (workspaceId) =>
          workspaceId === "workspace-a" ? tab : null,
        getWorkspaceActiveBrowserId: (workspaceId) => (workspaceId === "workspace-a" ? "a" : null),
        getBrowserWorkspaceId: (id) => (id === "a" ? "workspace-a" : null),
      });

      for (const [requestId, url] of [
        ["r-navigate-file", "file:///tmp/secret.txt"],
        ["r-navigate-js", "javascript:alert(1)"],
      ] as const) {
        await expect(
          executeAutomationCommand(
            {
              type: "browser.automation.execute.request",
              requestId,
              workspaceId: "workspace-a",
              command: { command: "navigate", args: { workspaceId: "workspace-a", url } },
            },
            registry,
          ),
        ).resolves.toEqual({
          requestId,
          ok: false,
          error: {
            code: "browser_denied",
            message: "Browser navigation only supports http and https URLs.",
            retryable: false,
          },
        });
      }

      expect(navigatedUrls).toEqual([]);
    });

    it("dispatches back, forward, and reload to the active browser", async () => {
      const actions: string[] = [];
      const tab = fakeTab({
        id: 12,
        goBack: () => actions.push("back"),
        goForward: () => actions.push("forward"),
        reload: () => actions.push("reload"),
      });
      const registry = createRegistry({
        getWorkspaceActiveTabContents: (workspaceId) =>
          workspaceId === "workspace-a" ? tab : null,
        getWorkspaceActiveBrowserId: (workspaceId) => (workspaceId === "workspace-a" ? "a" : null),
        getBrowserWorkspaceId: (id) => (id === "a" ? "workspace-a" : null),
      });

      const back = await executeAutomationCommand(
        {
          type: "browser.automation.execute.request",
          requestId: "r-back",
          workspaceId: "workspace-a",
          command: { command: "back", args: { workspaceId: "workspace-a" } },
        },
        registry,
      );
      const forward = await executeAutomationCommand(
        {
          type: "browser.automation.execute.request",
          requestId: "r-forward",
          workspaceId: "workspace-a",
          command: { command: "forward", args: { workspaceId: "workspace-a" } },
        },
        registry,
      );
      const reload = await executeAutomationCommand(
        {
          type: "browser.automation.execute.request",
          requestId: "r-reload",
          workspaceId: "workspace-a",
          command: { command: "reload", args: { workspaceId: "workspace-a" } },
        },
        registry,
      );

      expect(back).toEqual({
        requestId: "r-back",
        ok: true,
        result: { command: "back", browserId: "a" },
      });
      expect(forward).toEqual({
        requestId: "r-forward",
        ok: true,
        result: { command: "forward", browserId: "a" },
      });
      expect(reload).toEqual({
        requestId: "r-reload",
        ok: true,
        result: { command: "reload", browserId: "a" },
      });
      expect(actions).toEqual(["back", "forward", "reload"]);
    });
  });

  describe("screenshot", () => {
    it("captures a viewport screenshot through CDP when available", async () => {
      let captureParams: Record<string, unknown> | undefined;
      const tab = fakeTab({
        id: 13,
        executeJavaScript: async () => ({ width: 321, height: 123 }),
        sendDebugCommand: async (command, params) => {
          if (command === "Page.captureScreenshot") {
            captureParams = params;
            return { data: "iVBORw0KGgo=" };
          }
          throw new Error(`Unexpected CDP command ${command}`);
        },
        capturePage: async () => {
          throw new Error("capturePage should not be used when CDP is available");
        },
      });
      const registry = createRegistry({
        getWorkspaceActiveTabContents: (workspaceId) =>
          workspaceId === "workspace-a" ? tab : null,
        getWorkspaceActiveBrowserId: (workspaceId) => (workspaceId === "workspace-a" ? "a" : null),
        getBrowserWorkspaceId: (id) => (id === "a" ? "workspace-a" : null),
      });

      const result = await executeAutomationCommand(
        {
          type: "browser.automation.execute.request",
          requestId: "r-screenshot-cdp",
          workspaceId: "workspace-a",
          command: { command: "screenshot", args: { workspaceId: "workspace-a" } },
        },
        registry,
      );

      expect(result).toEqual({
        requestId: "r-screenshot-cdp",
        ok: true,
        result: {
          command: "screenshot",
          browserId: "a",
          mimeType: "image/png",
          dataBase64: "iVBORw0KGgo=",
          width: 321,
          height: 123,
        },
      });
      expect(captureParams).toEqual({ format: "png", fromSurface: false });
    });

    it("captures a PNG screenshot from the active browser", async () => {
      const tab = fakeTab({
        id: 13,
        capturePage: async () => ({
          toPNG: () => new Uint8Array([137, 80, 78, 71, 1, 2, 3]),
          getSize: () => ({ width: 640, height: 480 }),
        }),
      });
      const registry = createRegistry({
        getWorkspaceActiveTabContents: (workspaceId) =>
          workspaceId === "workspace-a" ? tab : null,
        getWorkspaceActiveBrowserId: (workspaceId) => (workspaceId === "workspace-a" ? "a" : null),
        getBrowserWorkspaceId: (id) => (id === "a" ? "workspace-a" : null),
      });

      const result = await executeAutomationCommand(
        {
          type: "browser.automation.execute.request",
          requestId: "r-screenshot",
          workspaceId: "workspace-a",
          command: { command: "screenshot", args: { workspaceId: "workspace-a" } },
        },
        registry,
      );

      expect(result).toEqual({
        requestId: "r-screenshot",
        ok: true,
        result: {
          command: "screenshot",
          browserId: "a",
          mimeType: "image/png",
          dataBase64: "iVBORwECAw==",
          width: 640,
          height: 480,
        },
      });
    });
  });

  describe("unsupported command", () => {
    it("returns browser_unsupported for unknown commands", () => {
      const registry = createRegistry();

      const result = executeAutomationCommand(
        {
          type: "browser.automation.execute.request",
          requestId: "r9",
          // Cast to bypass discriminated union — tests forward-compat fallback
          command: { command: "future_click", args: {} } as never,
        },
        registry,
      );

      expect(result).toEqual({
        requestId: "r9",
        ok: false,
        error: {
          code: "browser_unsupported",
          message: "Unsupported command: future_click",
          retryable: false,
        },
      });
    });
  });
});
