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

  it("includes composer and agent workflow keys for the Batch 2 migration", () => {
    expect(en.composer.placeholders.desktop).toBe(
      "Message the agent, tag @files, or use /commands and /skills",
    );
    expect(en.composer.input.addAttachment).toBe("Add attachment");
    expect(en.composer.input.sendMessage).toBe("Send message");
    expect(en.composer.voice.startDictation).toBe("Start dictation");
    expect(en.composer.attachments.addIssueOrPr).toBe("Add issue or PR");
    expect(en.composer.github.title).toBe("Attach issue or PR");
    expect(en.agentControls.provider.fallback).toBe("Provider");
    expect(en.agentControls.hints.model).toBe("Change model");
    expect(en.agentControls.features.title).toBe("Features");
    expect(en.agentControls.mode.title).toBe("Mode");
    expect(en.agentStream.permission.required).toBe("Permission Required");
    expect(en.agentStream.permission.proposedPlan).toBe("Proposed plan");
    expect(en.agentPanel.unavailable.selectedHost).toBe("Selected host");
    expect(en.agentPanel.states.notFound).toBe("Agent not found");
    expect(en.panels.draft.newAgent).toBe("New Agent");
  });
});
