import { describe, expect, it } from "vitest";
import { isReadOnlyTool } from "./tool-safety";

describe("isReadOnlyTool", () => {
  it("treats Hubcode built-in read tools as read-only", () => {
    for (const name of [
      "hubcode__list_agents",
      "hubcode__get_agent_status",
      "hubcode__list_terminals",
      "hubcode__capture_terminal",
      "hubcode__list_schedules",
      "hubcode__inspect_schedule",
      "hubcode__list_providers",
      "hubcode__list_models",
      "hubcode__list_worktrees",
      "hubcode__get_agent_activity",
      "hubcode__list_pending_permissions",
      "hubcode__wait_for_agent",
    ]) {
      expect(isReadOnlyTool(name), name).toBe(true);
    }
  });

  it("treats Hubcode built-in write/exec tools as not read-only", () => {
    for (const name of [
      "hubcode__create_agent",
      "hubcode__send_agent_prompt",
      "hubcode__cancel_agent",
      "hubcode__archive_agent",
      "hubcode__kill_agent",
      "hubcode__update_agent",
      "hubcode__create_terminal",
      "hubcode__kill_terminal",
      "hubcode__send_terminal_keys",
      "hubcode__create_schedule",
      "hubcode__pause_schedule",
      "hubcode__resume_schedule",
      "hubcode__delete_schedule",
      "hubcode__create_worktree",
      "hubcode__archive_worktree",
      "hubcode__set_agent_mode",
      "hubcode__respond_to_permission",
    ]) {
      expect(isReadOnlyTool(name), name).toBe(false);
    }
  });

  it("allows speak (voice output) explicitly", () => {
    expect(isReadOnlyTool("hubcode__speak")).toBe(true);
  });

  it("blocks common external write/exec tool names", () => {
    for (const name of [
      "fs__write_file",
      "fs__edit_file",
      "fs__create_directory",
      "fs__delete_file",
      "git__commit",
      "git__push",
      "shell__exec",
      "bash__run",
      "github__create_pull_request",
    ]) {
      expect(isReadOnlyTool(name), name).toBe(false);
    }
  });

  it("allows common external read tool names", () => {
    for (const name of [
      "fs__read_file",
      "fs__list_directory",
      "fs__search_files",
      "git__diff_files",
      "github__get_pull_request",
      "github__list_issues",
    ]) {
      expect(isReadOnlyTool(name), name).toBe(true);
    }
  });

  it("conservatively blocks unknown tool names", () => {
    // No prefix match, no allowlist hit → drop in plan mode.
    expect(isReadOnlyTool("hubcode__foo_bar")).toBe(false);
    expect(isReadOnlyTool("custom__do_thing")).toBe(false);
  });

  it("blocks tools whose names mix a read prefix with a write token", () => {
    // Hypothetical/adversarial: a tool named like a getter but actually writes.
    expect(isReadOnlyTool("hubcode__get_and_delete_record")).toBe(false);
  });

  it("handles flat names without a server prefix", () => {
    expect(isReadOnlyTool("list_things")).toBe(true);
    expect(isReadOnlyTool("write_thing")).toBe(false);
  });
});
