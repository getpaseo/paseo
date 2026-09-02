import {
  BROWSER_TOOL_NAMES,
  type BrowserToolName,
} from "@getpaseo/protocol/browser-automation/rpc-schemas";
import { describe, expect, it } from "vitest";
import { createBrowserCommand } from "./index.js";

const SUBCOMMAND_BY_TOOL: Record<BrowserToolName, string> = {
  browser_list_tabs: "tabs",
  browser_new_tab: "new-tab",
  browser_snapshot: "snapshot",
  browser_click: "click",
  browser_fill: "fill",
  browser_wait: "wait",
  browser_type: "type",
  browser_keypress: "keypress",
  browser_navigate: "navigate",
  browser_back: "back",
  browser_forward: "forward",
  browser_reload: "reload",
  browser_screenshot: "screenshot",
  browser_upload: "upload",
  browser_select: "select",
  browser_hover: "hover",
  browser_drag: "drag",
  browser_logs: "logs",
  browser_evaluate: "evaluate",
  browser_scroll: "scroll",
  browser_resize: "resize",
  browser_close_tab: "close-tab",
};

describe("paseo browser command surface", () => {
  it("exposes one subcommand per browser MCP tool", () => {
    const registered = new Set(createBrowserCommand().commands.map((command) => command.name()));
    const missing = BROWSER_TOOL_NAMES.filter((tool) => !registered.has(SUBCOMMAND_BY_TOOL[tool]));

    expect(missing).toEqual([]);
    expect(registered.size).toBe(BROWSER_TOOL_NAMES.length);
  });

  it("keeps the subcommand map in sync with the protocol tool list", () => {
    expect(Object.keys(SUBCOMMAND_BY_TOOL).sort()).toEqual([...BROWSER_TOOL_NAMES].sort());
  });

  it("scopes tab creation and listing to a workspace", () => {
    const commands = createBrowserCommand().commands;
    const newTab = commands.find((command) => command.name() === "new-tab");
    const flags = newTab?.options.map((option) => option.long) ?? [];

    expect(flags).toContain("--cwd");
    expect(flags).toContain("--workspace");
  });
});
