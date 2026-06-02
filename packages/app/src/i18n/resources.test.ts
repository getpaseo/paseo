import { describe, expect, it } from "vitest";
import { en } from "./resources/en";
import { zhCN } from "./resources/zh-CN";

function flattenKeys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) {
    return [prefix];
  }

  const entries = Object.entries(value);
  return entries.flatMap(([key, child]) => flattenKeys(child, prefix ? `${prefix}.${key}` : key));
}

describe("translation resources", () => {
  it("keeps Simplified Chinese keys in sync with English", () => {
    expect(flattenKeys(zhCN).sort()).toEqual(flattenKeys(en).sort());
  });

  it("includes shared shell keys for the Batch 1 migration", () => {
    expect(en.common.actions.back).toBe("Back");
    expect(en.common.actions.close).toBe("Close");
    expect(en.common.actions.dismiss).toBe("Dismiss");
    expect(en.common.actions.search).toBe("Search");
    expect(en.common.states.starting).toBe("Starting...");
    expect(en.common.states.downloadComplete).toBe("Download complete");
    expect(en.common.states.downloadFailed).toBe("Download failed");
    expect(en.shell.menu.toggleSidebar).toBe("Toggle sidebar");
    expect(en.shell.menu.open).toBe("Open menu");
    expect(en.shell.menu.close).toBe("Close menu");
    expect(en.shell.commandCenter.placeholder).toBe("Type a command or search agents...");
    expect(en.shell.commandCenter.noMatches).toBe("No matches");
    expect(en.shell.commandCenter.actions).toBe("Actions");
    expect(en.shell.commandCenter.agents).toBe("Agents");
    expect(en.shell.commandCenter.newAgent).toBe("New agent");
  });
});
