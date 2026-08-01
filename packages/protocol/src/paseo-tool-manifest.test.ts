import { describe, expect, test } from "vitest";
import { PASEO_TOOL_MANIFEST } from "./paseo-tool-manifest.js";

const EXPECTED_TOOL_IDS = [
  "create_workspace",
  "list_workspaces",
  "archive_workspace",
  "rename_workspace",
  "list_workspace_scripts",
  "start_workspace_script",
  "stop_workspace_script",
  "create_agent",
  "send_agent_prompt",
  "get_agent_status",
  "list_agents",
  "cancel_agent",
  "archive_agent",
  "kill_agent",
  "update_agent",
  "get_agent_activity",
  "set_agent_mode",
  "list_pending_permissions",
  "respond_to_permission",
  "list_terminals",
  "create_terminal",
  "kill_terminal",
  "capture_terminal",
  "send_terminal_keys",
  "create_schedule",
  "create_heartbeat",
  "delete_heartbeat",
  "list_schedules",
  "inspect_schedule",
  "pause_schedule",
  "resume_schedule",
  "delete_schedule",
  "update_schedule",
  "schedule_logs",
  "run_schedule_once",
  "list_providers",
  "list_models",
  "inspect_provider",
  "browser_list_tabs",
  "browser_new_tab",
  "browser_snapshot",
  "browser_click",
  "browser_fill",
  "browser_wait",
  "browser_type",
  "browser_keypress",
  "browser_navigate",
  "browser_back",
  "browser_forward",
  "browser_reload",
  "browser_screenshot",
  "browser_upload",
  "browser_hover",
  "browser_select",
  "browser_drag",
  "browser_logs",
  "browser_evaluate",
  "browser_scroll",
  "browser_resize",
  "browser_close_tab",
] as const;

describe("Paseo tool manifest", () => {
  test("lists every current core and browser tool except voice-only speak", () => {
    expect(PASEO_TOOL_MANIFEST.map((entry) => entry.id)).toEqual(EXPECTED_TOOL_IDS);
    expect(new Set(PASEO_TOOL_MANIFEST.map((entry) => entry.id)).size).toBe(
      PASEO_TOOL_MANIFEST.length,
    );
    expect(PASEO_TOOL_MANIFEST.some((entry) => entry.id === "speak")).toBe(false);
  });

  test("provides grouped labels and descriptions with browser flags", () => {
    expect(PASEO_TOOL_MANIFEST.find((entry) => entry.id === "create_workspace")).toMatchObject({
      label: "Create workspace",
      group: "Workspaces",
    });
    expect(PASEO_TOOL_MANIFEST.find((entry) => entry.id === "list_providers")).toMatchObject({
      label: "List providers",
      group: "Providers",
    });
    expect(PASEO_TOOL_MANIFEST.find((entry) => entry.id === "browser_snapshot")).toMatchObject({
      label: "Snapshot browser page",
      group: "Browser",
      browser: true,
    });

    for (const entry of PASEO_TOOL_MANIFEST) {
      expect(entry.label).toMatch(/\S/);
      expect(entry.description).toMatch(/\S/);
    }

    expect(PASEO_TOOL_MANIFEST.filter((entry) => entry.browser)).toHaveLength(22);
    expect(PASEO_TOOL_MANIFEST.filter((entry) => !entry.browser)).toHaveLength(38);
  });
});
