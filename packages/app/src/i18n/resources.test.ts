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
    expect(en.common.actions.cancel).toBe("Cancel");
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

  it("includes Settings expansion keys for the Batch 3A migration", () => {
    expect(en.settings.diagnostics.title).toBe("Diagnostics");
    expect(en.settings.about.title).toBe("About");
    expect(en.settings.about.releaseChannel.label).toBe("Release channel");
    expect(en.settings.appearance.theme.title).toBe("Theme");
    expect(en.settings.appearance.fonts.interfaceFont).toBe("Interface font");
    expect(en.settings.shortcuts.actions.rebind).toBe("Rebind");
    expect(en.settings.integrations.commandLine.title).toBe("Command line");
    expect(en.settings.integrations.skills.updateAvailable).toBe("Update available");
    expect(en.settings.permissions.notifications).toBe("Notifications");
    expect(en.settings.permissions.actions.request).toBe("Request");
  });

  it("includes Settings expansion keys for the Batch 3B migration", () => {
    expect(en.settings.host.notFound).toBe("Host not found");
    expect(en.settings.host.connections.title).toBe("Connections");
    expect(en.settings.host.daemon.restart.title).toBe("Restart daemon");
    expect(en.settings.host.orchestration.enableTools.title).toBe("Enable Paseo tools");
    expect(en.settings.providers.title).toBe("Providers");
    expect(en.settings.providers.models.addModel).toBe("Add model");
    expect(en.settings.providers.diagnostic.title).toBe("Diagnostic");
    expect(en.settings.project.worktree.title).toBe("Worktree lifecycle hooks");
    expect(en.settings.project.scripts.actions.add).toBe("Add script");
    expect(en.settings.project.metadata.title).toBe("Metadata generation");
    expect(en.settings.project.actions.save).toBe("Save");
  });
});
