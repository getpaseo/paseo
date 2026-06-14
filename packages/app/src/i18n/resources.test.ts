import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { ar } from "./resources/ar";
import { en } from "./resources/en";
import { es } from "./resources/es";
import { fr } from "./resources/fr";
import { ru } from "./resources/ru";
import { zhCN } from "./resources/zh-CN";

function flattenKeys(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) {
    return [prefix];
  }

  const entries = Object.entries(value);
  return entries.flatMap(([key, child]) => flattenKeys(child, prefix ? `${prefix}.${key}` : key));
}

function flattenStrings(value: unknown, prefix = ""): Record<string, string> {
  if (typeof value === "string") {
    return { [prefix]: value };
  }
  if (typeof value !== "object" || value === null) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) =>
      Object.entries(flattenStrings(child, prefix ? `${prefix}.${key}` : key)),
    ),
  );
}

function countMatchingEnglishStrings(resource: unknown): number {
  const englishStrings = flattenStrings(en);
  const localeStrings = flattenStrings(resource);
  return Object.entries(englishStrings).filter(([key, value]) => localeStrings[key] === value)
    .length;
}

function findInterpolationMismatches(resource: unknown): string[] {
  const interpolationPattern = /\{\{[^}]+\}\}/g;
  const englishStrings = flattenStrings(en);
  const localeStrings = flattenStrings(resource);
  return Object.entries(englishStrings).flatMap(([key, value]) => {
    const expected = [...value.matchAll(interpolationPattern)].map((match) => match[0]).sort();
    const actual = [...(localeStrings[key] ?? "").matchAll(interpolationPattern)]
      .map((match) => match[0])
      .sort();
    return expected.join("|") === actual.join("|")
      ? []
      : [`${key}: ${expected.join(", ")} -> ${actual.join(", ")}`];
  });
}

const appSourceRoot = join(__dirname, "..");
const untranslatedConnectionErrors = [
  "Daemon unavailable",
  "Daemon client unavailable",
  "Daemon client not available",
  "Daemon client is disconnected",
  "Host is not connected",
] as const;
const untranslatedLocalFallbacks = [
  "No file found for ",
  "Unable to load pull request status",
  "Unable to load pull request activity",
  "An unexpected error occurred while handling dictation.",
  "Unable to load desktop settings.",
  "Unable to save desktop settings.",
] as const;

function collectSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "i18n") {
        return [];
      }
      return collectSourceFiles(path);
    }
    if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\./.test(entry.name)) {
      return [];
    }
    return [path];
  });
}

function findUntranslatedConnectionErrors(): string[] {
  return collectSourceFiles(appSourceRoot).flatMap((path) => {
    const contents = readFileSync(path, "utf8");
    const matches = [...untranslatedConnectionErrors, ...untranslatedLocalFallbacks].filter(
      (text) => contents.includes(`"${text}"`) || contents.includes(`\`${text}`),
    );
    if (matches.length === 0) {
      return [];
    }
    return [`${relative(appSourceRoot, path)}: ${matches.join(", ")}`];
  });
}

describe("translation resources", () => {
  it("keeps UN official language keys in sync with English", () => {
    const englishKeys = flattenKeys(en).sort();
    expect(flattenKeys(ar).sort()).toEqual(englishKeys);
    expect(flattenKeys(es).sort()).toEqual(englishKeys);
    expect(flattenKeys(fr).sort()).toEqual(englishKeys);
    expect(flattenKeys(ru).sort()).toEqual(englishKeys);
    expect(flattenKeys(zhCN).sort()).toEqual(englishKeys);
  });

  it("keeps non-English UN official languages translated beyond fallback labels", () => {
    const totalStrings = Object.keys(flattenStrings(en)).length;
    const maxFallbackStrings = Math.floor(totalStrings * 0.25);
    expect(countMatchingEnglishStrings(ar)).toBeLessThan(maxFallbackStrings);
    expect(countMatchingEnglishStrings(es)).toBeLessThan(maxFallbackStrings);
    expect(countMatchingEnglishStrings(fr)).toBeLessThan(maxFallbackStrings);
    expect(countMatchingEnglishStrings(ru)).toBeLessThan(maxFallbackStrings);
  });

  it("preserves interpolation placeholders in every language", () => {
    expect(findInterpolationMismatches(ar)).toEqual([]);
    expect(findInterpolationMismatches(es)).toEqual([]);
    expect(findInterpolationMismatches(fr)).toEqual([]);
    expect(findInterpolationMismatches(ru)).toEqual([]);
    expect(findInterpolationMismatches(zhCN)).toEqual([]);
  });

  it("keeps reported Spanish settings and scripts labels clean", () => {
    expect(es.workspace.scripts.title).toBe("Scripts");
    expect(es.settings.general.terminalScrollback.label).toBe("Historial de terminal");
    expect(es.settings.project.scripts.title).toBe("Scripts");
  });

  it("keeps model count labels spaced around the count", () => {
    expect(ar.modelSelector.modelCountPlural).toBe("{{count}} نماذج");
    expect(es.modelSelector.modelCountPlural).toBe("{{count}} modelos");
    expect(fr.modelSelector.modelCountPlural).toBe("{{count}} modèles");
    expect(ru.modelSelector.modelCountPlural).toBe("{{count}} моделей");
    expect(zhCN.modelSelector.modelCountPlural).toBe("{{count}} 个模型");
    expect(ar.settings.providers.models.many).toBe("{{count}} نماذج");
    expect(es.settings.providers.models.many).toBe("{{count}} modelos");
    expect(fr.settings.providers.models.many).toBe("{{count}} modèles");
    expect(ru.settings.providers.models.many).toBe("{{count}} моделей");
    expect(zhCN.settings.providers.models.many).toBe("{{count}} 个 Model");
  });

  it("keeps local connection fallback errors translated", () => {
    expect(findUntranslatedConnectionErrors()).toEqual([]);
  });

  it("includes shared shell keys for the Batch 1 migration", () => {
    expect(en.common.actions.back).toBe("Back");
    expect(en.common.actions.cancel).toBe("Cancel");
    expect(en.common.actions.close).toBe("Close");
    expect(en.common.actions.dismiss).toBe("Dismiss");
    expect(en.common.actions.retry).toBe("Retry");
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
    expect(en.shell.commandCenter.openProject).toBe("Open project");
    expect(en.shell.commandCenter.home).toBe("Home");
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

  it("includes workspace and panel keys for the Batch 4A migration", () => {
    expect(en.importSession.title).toBe("Import session");
    expect(en.importSession.status.connectHost).toBe("Connect to a host to import sessions");
    expect(en.importSession.actions.refresh).toBe("Refresh sessions");
    expect(en.workspace.fileExplorer.sort.name).toBe("Name");
    expect(en.workspace.fileExplorer.empty.noFiles).toBe("No files");
    expect(en.workspace.setup.status.running).toBe("Running");
    expect(en.workspace.setup.empty.noCommands).toBe("No setup commands ran for this workspace.");
    expect(en.workspace.browser.unavailable.title).toBe("Browser is desktop-only");
    expect(en.workspace.browser.controls.enterUrl).toBe("Enter URL");
    expect(en.workspace.terminal.hostDisconnected).toBe("Host is not connected");
    expect(en.panels.file.directoryMissing).toBe("Workspace directory not found.");
  });

  it("includes workspace Git and review keys for the Batch 4B migration", () => {
    expect(en.workspace.tabs.actions.newAgent).toBe("New agent");
    expect(en.workspace.header.actions.copyPath).toBe("Copy workspace path");
    expect(en.workspace.scripts.actions.run).toBe("Run");
    expect(en.workspace.git.actions.commit.label).toBe("Commit");
    expect(en.workspace.git.diff.binaryFile).toBe("Binary file");
    expect(en.workspace.git.pr.sections.checks).toBe("Checks");
    expect(en.review.comment.placeholder).toBe("Leave a comment");
  });

  it("includes sidebar and workspace creation keys for the Batch 4C migration", () => {
    expect(en.sidebar.workspace.actions.copyPath).toBe("Copy path");
    expect(en.sidebar.project.confirmations.removeTitle).toBe("Remove project?");
    expect(en.newWorkspace.title).toBe("New workspace");
    expect(en.newWorkspace.refPicker.searchPlaceholder).toBe("Search branches and PRs");
    expect(en.openProject.tiles.addProject.title).toBe("Add a project");
  });

  it("includes provider selector and pairing keys for the Batch 4D migration", () => {
    expect(en.modelSelector.title).toBe("Select provider");
    expect(en.modelSelector.favorites).toBe("Favorites");
    expect(en.providerCatalog.title).toBe("Add provider");
    expect(en.providerCatalog.actions.installInstructions).toBe("Install instructions");
    expect(en.pairing.link.title).toBe("Paste pairing link");
    expect(en.pairing.connectionMethods.direct.title).toBe("Direct connection");
  });

  it("includes onboarding and direct connection keys for the Batch 4E migration", () => {
    expect(en.onboarding.title).toBe("Welcome to Paseo");
    expect(en.onboarding.actions.settings).toBe("Settings");
    expect(en.pairing.direct.title).toBe("Direct connection");
    expect(en.pairing.direct.fields.host).toBe("Host");
    expect(en.pairing.scan.title).toBe("Scan QR");
    expect(en.pairing.device.copy).toBe("Copy");
  });

  it("includes shared utility chrome keys for the Batch 4F migration", () => {
    expect(en.realtimeVoice.actions.mute).toBe("Mute realtime voice");
    expect(en.rewind.actions.conversation).toBe("Rewind conversation");
    expect(en.rewind.warning).toBe("This action cannot be undone");
    expect(en.diffViewer.empty).toBe("No changes to display");
    expect(en.serviceUrl.title).toBe("Open service URL");
  });

  it("includes keyboard shortcut help keys for the Batch 4G migration", () => {
    expect(en.settings.shortcuts.dialogTitle).toBe("Shortcuts");
    expect(en.settings.shortcuts.sections.tabsPanes).toBe("Tabs & Panes");
    expect(en.settings.shortcuts.help.toggleCommandCenter).toBe("Toggle command center");
    expect(en.settings.shortcuts.helpNotes.showKeyboardShortcuts).toBe(
      "Available when focus is not in a text field or terminal.",
    );
  });

  it("includes sessions and agent list keys for the Batch 4H migration", () => {
    expect(en.sessions.title).toBe("Sessions");
    expect(en.sessions.empty).toBe("No sessions yet");
    expect(en.sessions.actions.loadMore).toBe("Load more");
    expect(en.agentList.fallbackTitle).toBe("New session");
    expect(en.agentList.dateSections.today).toBe("Today");
    expect(en.agentList.dateSections.older).toBe("Older");
    expect(en.agentList.status.initializing).toBe("Starting");
    expect(en.agentList.status.running).toBe("Running");
    expect(en.agentList.badges.archived).toBe("Archived");
    expect(en.agentList.badges.pending).toBe("{{count}} pending");
    expect(en.agentList.badges.attention).toBe("Attention");
    expect(en.agentList.archiveSheet.hostOffline).toBe("Host offline");
    expect(en.agentList.archiveSheet.runningAgent).toBe(
      "This agent is still running. Archiving it will stop the agent.",
    );
    expect(en.agentList.archiveSheet.archive).toBe("Archive");
  });

  it("includes message utility keys for the Batch 4I migration", () => {
    expect(en.message.actions.copyCode).toBe("Copy code");
    expect(en.message.actions.copyTurn).toBe("Copy turn");
    expect(en.message.actions.copyMessage).toBe("Copy message");
    expect(en.message.actions.copied).toBe("Copied");
    expect(en.message.attachments.dismissImage).toBe("Dismiss image");
    expect(en.message.attachments.closeImage).toBe("Close image");
    expect(en.message.attachments.imageLoadFailed).toBe("Couldn't load image");
    expect(en.message.attachments.imageUnavailable).toBe("Image unavailable");
    expect(en.message.dictation.start).toBe("Start voice dictation");
    expect(en.message.dictation.cancel).toBe("Cancel dictation");
    expect(en.message.dictation.retry).toBe("Retry dictation");
    expect(en.message.dictation.insert).toBe("Insert transcription");
    expect(en.message.dictation.insertAndSend).toBe("Insert transcription and send");
    expect(en.message.dictation.failed).toBe("Dictation failed: {{error}}");
    expect(en.message.dictation.failedRetry).toBe("Dictation failed. Tap retry.");
    expect(en.message.question.submit).toBe("Submit");
    expect(en.message.question.answerPlaceholder).toBe("Type your answer...");
    expect(en.message.question.otherPlaceholder).toBe("Other...");
    expect(en.message.todo.title).toBe("Tasks");
    expect(en.message.todo.empty).toBe("No tasks yet.");
  });

  it("includes workspace tab toast keys for the Batch 4J migration", () => {
    expect(en.workspace.tabs.emptyPane).toBe("No tabs in this pane.");
    expect(en.workspace.tabs.toasts.copyFailed).toBe("Copy failed");
    expect(en.workspace.tabs.toasts.agentIdCopiedLabel).toBe("Agent ID");
    expect(en.workspace.tabs.toasts.resumeCommandCopiedLabel).toBe("resume command");
    expect(en.workspace.tabs.toasts.resumeIdUnavailable).toBe("Resume ID not available");
    expect(en.workspace.tabs.toasts.resumeCommandUnavailable).toBe("Resume command not available");
    expect(en.workspace.tabs.toasts.reloadingAgent).toBe("Reloading agent...");
    expect(en.workspace.tabs.toasts.reloadedAgent).toBe("Reloaded agent");
    expect(en.workspace.tabs.toasts.failedToReloadAgent).toBe("Failed to reload agent");
    expect(en.workspace.header.toasts.workspacePathCopiedLabel).toBe("Workspace path");
    expect(en.workspace.header.toasts.branchNameCopiedLabel).toBe("Branch name");
  });

  it("includes sidebar project list keys for the Batch 4K migration", () => {
    expect(en.sidebar.host.noHost).toBe("No host");
    expect(en.sidebar.host.switchTitle).toBe("Switch host");
    expect(en.sidebar.host.searchPlaceholder).toBe("Search hosts...");
    expect(en.sidebar.actions.addProject).toBe("Add project");
    expect(en.sidebar.actions.home).toBe("Home");
    expect(en.sidebar.actions.settings).toBe("Settings");
    expect(en.sidebar.actions.closeSidebar).toBe("Close sidebar");
    expect(en.sidebar.sections.sessions).toBe("Sessions");
    expect(en.sidebar.workspace.actions.newWorkspace).toBe("New workspace");
    expect(en.sidebar.workspace.actions.createWorkspaceFor).toBe(
      "Create a new workspace for {{projectName}}",
    );
    expect(en.sidebar.project.empty.title).toBe("No projects yet");
    expect(en.sidebar.project.empty.description).toBe("Add a project to get started");
    expect(en.settings.projectList.hostLoadFailed).toBe(
      "Couldn't load projects from host {{hostName}}: {{message}}",
    );
  });

  it("includes picker, file pane, and tool detail keys for the Batch 4L migration", () => {
    expect(en.projectPicker.placeholder).toBe("Type a directory path...");
    expect(en.projectPicker.opening).toBe("Opening project...");
    expect(en.projectPicker.empty).toBe("Start typing a path");
    expect(en.branchSwitcher.currentBranch).toBe(
      "Current branch: {{branchName}}. Press to switch branch.",
    );
    expect(en.branchSwitcher.placeholder).toBe("Switch branch...");
    expect(en.branchSwitcher.searchPlaceholder).toBe("Filter branches...");
    expect(en.branchSwitcher.empty).toBe("No branches found.");
    expect(en.branchSwitcher.title).toBe("Switch branch");
    expect(en.panels.file.loading).toBe("Loading file...");
    expect(en.panels.file.noPreview).toBe("No preview available");
    expect(en.panels.file.binaryPreviewUnavailable).toBe("Binary preview unavailable");
    expect(en.panels.file.failedToLoad).toBe("Failed to load file");
    expect(en.toolCallDetails.error).toBe("Error");
    expect(en.toolCallDetails.empty).toBe("No additional details available");
    expect(en.message.actions.openFile).toBe("Open file");
  });

  it("includes hook and modal utility keys for the Batch 4M migration", () => {
    expect(en.imageAttachmentPicker.permissionTitle).toBe("Permission required");
    expect(en.imageAttachmentPicker.permissionMessage).toBe(
      "Please allow access to your photo library to attach images.",
    );
    expect(en.imageAttachmentPicker.errorTitle).toBe("Error");
    expect(en.imageAttachmentPicker.failedToSelect).toBe("Failed to select image");
    expect(en.imageAttachmentPicker.dialogTitle).toBe("Attach images");
    expect(en.imageAttachmentPicker.dialogFilterName).toBe("Images");
    expect(en.common.states.copied).toBe("Copied");
    expect(en.common.states.copiedLabel).toBe("Copied {{label}}");
    expect(en.common.errors.unableToSave).toBe("Unable to save");
    expect(en.common.errors.nameRequired).toBe("Name is required");
    expect(en.common.errors.daemonUnavailable).toBe("Daemon unavailable");
    expect(en.common.errors.daemonClientUnavailable).toBe("Daemon client unavailable");
    expect(en.common.errors.daemonClientDisconnected).toBe("Daemon client is disconnected");
    expect(en.common.errors.noFileFound).toBe("No file found for {{token}}");
    expect(en.common.errors.unexpectedDictationError).toBe(
      "An unexpected error occurred while handling dictation.",
    );
    expect(en.common.connectionStatus.online).toBe("Online");
    expect(en.common.connectionStatus.connecting).toBe("Connecting");
    expect(en.common.connectionStatus.offline).toBe("Offline");
    expect(en.common.connectionStatus.idle).toBe("Idle");
    expect(en.agentList.dateSections.recent).toBe("Recent");
    expect(en.message.attachments.imagePreviewUnavailable).toBe("Image preview unavailable.");
    expect(en.message.attachments.imagePreviewLoadFailed).toBe("Unable to load image preview.");
    expect(en.workspace.tabs.explorer.changes).toBe("Changes");
    expect(en.workspace.tabs.explorer.files).toBe("Files");
    expect(en.branchSwitcher.uncommittedTitle).toBe("Uncommitted changes");
    expect(en.branchSwitcher.uncommittedMessage).toBe(
      "You have uncommitted changes. Stash them before switching branches?",
    );
    expect(en.branchSwitcher.stashAndSwitch).toBe("Stash & Switch");
    expect(en.branchSwitcher.failedToStash).toBe("Failed to stash changes");
    expect(en.branchSwitcher.failedToSwitch).toBe("Failed to switch branch");
    expect(en.workspaceSetup.errors.failedCreateWorktree).toBe("Failed to create worktree");
    expect(en.workspaceSetup.errors.failedOpenProject).toBe("Failed to open project");
    expect(en.workspaceSetup.errors.selectModel).toBe("Select a model");
    expect(en.workspaceSetup.errors.hostDisconnected).toBe("Host is not connected");
    expect(en.workspaceSetup.errors.pendingRequired).toBe("No workspace setup is pending");
    expect(en.workspaceSetup.errors.composerStateRequired).toBe(
      "Workspace setup composer state is required",
    );
    expect(en.workspaceSetup.title).toBe("Create workspace");
    expect(en.workspace.git.pr.errors.statusLoadFailed).toBe("Unable to load pull request status");
    expect(en.workspace.git.pr.errors.activityLoadFailed).toBe(
      "Unable to load pull request activity",
    );
    expect(en.desktop.settings.loadFailed).toBe("Unable to load desktop settings.");
    expect(en.desktop.settings.saveFailed).toBe("Unable to save desktop settings.");
    expect(en.toolCallDetails.input).toBe("Input");
    expect(en.toolCallDetails.output).toBe("Output");
    expect(en.renameModal.rename).toBe("Rename");
    expect(en.renameModal.saving).toBe("Saving...");
    expect(en.sidebarCallout.dismiss).toBe("Dismiss");
    expect(en.contextWindow.title).toBe("Context window");
    expect(en.contextWindow.used).toBe("{{percentage}}% used");
  });

  it("includes view-model and policy utility keys for the Batch 4N migration", () => {
    expect(en.importSession.preview.untitledSession).toBe("Untitled session");
    expect(en.importSession.preview.noPrompt).toBe("No prompt preview");
    expect(en.importSession.empty.noRecent).toBe("No recent sessions to import.");
    expect(en.importSession.empty.alreadyImported).toBe(
      "All recent sessions are already imported.",
    );
    expect(en.importSession.empty.noProviderSessions).toBe("No {{provider}} sessions found.");
    expect(en.sidebar.worktreeSetup.title).toBe("Set up worktree scripts");
    expect(en.sidebar.worktreeSetup.description).toBe(
      "Add setup commands so new worktrees can install dependencies and prepare themselves automatically.",
    );
    expect(en.sidebar.worktreeSetup.openProjectSettings).toBe("Open project settings");
  });

  it("includes remaining small utility chrome keys for the Batch 4O migration", () => {
    expect(en.workspace.route.loading).toBe("Loading workspace");
    expect(en.workspace.route.connecting).toBe("Connecting");
    expect(en.workspace.route.hostOffline).toBe("{{hostName}} is offline");
    expect(en.workspace.route.cannotReachHost).toBe("Cannot reach {{hostName}}");
    expect(en.workspace.route.hostStatus).toBe("Host status: {{status}}");
    expect(en.workspace.route.missing).toBe("Workspace not found");
    expect(en.message.compaction.loading).toBe("Compacting...");
    expect(en.message.compaction.auto).toBe("Context automatically compacted");
    expect(en.message.compaction.manual).toBe("Context manually compacted");
    expect(en.message.compaction.withTokens).toBe("Context compacted ({{tokens}}K tokens)");
    expect(en.message.compaction.completed).toBe("Context compacted");
    expect(en.agentPanel.archived.callout).toBe("This agent is archived");
    expect(en.agentPanel.archived.unarchive).toBe("Unarchive");
    expect(en.desktop.quitting.title).toBe("Quitting Paseo...");
    expect(en.desktop.quitting.detail).toBe("Stopping the local daemon.");
    expect(en.composer.attachments.dropImagesHere).toBe("Drop images here");
  });

  it("includes provider selection utility keys for the Batch 4P migration", () => {
    expect(en.providerSelection.defaultModel).toBe("Default");
    expect(en.providerSelection.selectModel).toBe("Select model");
    expect(en.providerSelection.loading).toBe("Loading...");
    expect(en.providerSelection.error).toBe("Error");
    expect(en.providerSelection.unavailable).toBe("Unavailable");
    expect(en.providerSelection.unknownError).toBe("Unknown error");
    expect(en.providerSelection.readiness.initialPromptRequired).toBe("Initial prompt is required");
    expect(en.providerSelection.readiness.noProviders).toBe(
      "No available providers on the selected host",
    );
    expect(en.providerSelection.readiness.modelDefaultsLoading).toBe(
      "Model defaults are still loading",
    );
  });

  it("includes desktop update utility keys for the Batch 4Q migration", () => {
    expect(en.desktop.updates.status.checking).toBe("Checking for app updates...");
    expect(en.desktop.updates.status.installing).toBe("Installing app update...");
    expect(en.desktop.updates.status.upToDate).toBe("App is up to date.");
    expect(en.desktop.updates.status.pending).toBe("We'll let you know when the update is ready.");
    expect(en.desktop.updates.status.availableWithVersion).toBe("Update ready: {{version}}");
    expect(en.desktop.updates.status.available).toBe("An app update is ready to install.");
    expect(en.desktop.updates.status.installed).toBe("App update installed. Restart required.");
    expect(en.desktop.updates.status.failed).toBe("Failed to update app.");
    expect(en.desktop.updates.status.idle).toBe("Update status has not been checked yet.");
    expect(en.desktop.updates.installError).toBe("Unable to install the desktop app update.");
    expect(en.desktop.updates.callout.installingTitle).toBe("Installing update");
    expect(en.desktop.updates.callout.failedTitle).toBe("Update failed");
    expect(en.desktop.updates.callout.availableTitle).toBe("Update available");
    expect(en.desktop.updates.callout.genericError).toBe("Something went wrong.");
    expect(en.desktop.updates.callout.whatsNew).toBe("What's new");
    expect(en.desktop.updates.callout.installAndRestart).toBe("Install & restart");
    expect(en.desktop.updates.callout.installingDescription).toBe("Installing and restarting...");
    expect(en.desktop.updates.callout.versionReady).toBe("{{version}} is ready to install.");
    expect(en.desktop.updates.callout.newVersionReady).toBe("A new version is ready to install.");
    expect(en.desktop.updates.callout.restartWarning).toBe(
      "Upgrading the app will stop running agents and close terminal sessions.",
    );
    expect(en.desktop.rosetta.title).toBe("Download the Apple Silicon build");
    expect(en.desktop.rosetta.runningIntel).toBe(
      "You're running the Intel build of Paseo under Rosetta on Apple Silicon.",
    );
    expect(en.desktop.rosetta.highCpu).toBe(
      "This causes high CPU usage. Download the Apple Silicon build to fix it.",
    );
    expect(en.desktop.rosetta.download).toBe("Download");
  });

  it("includes desktop permission utility keys for the Batch 4R migration", () => {
    expect(en.desktop.permissions.notifications.allowed).toBe(
      "Notifications are allowed by the OS.",
    );
    expect(en.desktop.permissions.notifications.denied).toBe(
      "Notifications are denied in system settings.",
    );
    expect(en.desktop.permissions.notifications.unexpectedState).toBe(
      "Unexpected notification permission state: {{state}}",
    );
    expect(en.desktop.permissions.microphone.granted).toBe("Microphone access is granted.");
    expect(en.desktop.permissions.microphone.statusApiUnavailable).toBe(
      "Microphone status API is unavailable in this runtime. Use Request to check access.",
    );
    expect(en.desktop.permissions.microphone.requestDenied).toBe(
      "Microphone permission was denied by the user or system.",
    );
    expect(en.desktop.permissions.empty.notifications).toBe(
      "Notification status has not been checked yet.",
    );
    expect(en.desktop.permissions.testNotification.title).toBe("Paseo notification test");
    expect(en.desktop.permissions.testNotification.failed).toBe("Failed to send notification.");
  });

  it("includes desktop daemon settings keys for the Batch 4S migration", () => {
    expect(en.desktop.daemon.title).toBe("Daemon");
    expect(en.desktop.daemon.status.title).toBe("Status");
    expect(en.desktop.daemon.status.builtInOnly).toBe(
      "Only the built-in desktop daemon is shown here",
    );
    expect(en.desktop.daemon.status.notRunning).toBe("not running");
    expect(en.desktop.daemon.status.pid).toBe("PID {{pid}}");
    expect(en.desktop.daemon.management.pauseTitle).toBe("Pause built-in daemon");
    expect(en.desktop.daemon.management.pauseAndStop).toBe("Pause and stop");
    expect(en.desktop.daemon.logs.modalTitle).toBe("Daemon logs");
    expect(en.desktop.daemon.logs.unavailable).toBe("Log path unavailable");
    expect(en.desktop.daemon.fullStatus.modalTitle).toBe("Daemon status");
    expect(en.desktop.daemon.fullStatus.fetchFailed).toBe(
      "Failed to fetch daemon status: {{message}}",
    );
    expect(en.desktop.daemon.loadFailed).toBe("Unable to load desktop daemon status.");
    expect(en.desktop.integrations.cli.installFailed).toBe("Unable to install the Paseo CLI.");
    expect(en.desktop.integrations.skills.installFailed).toBe(
      "Unable to install orchestration skills.",
    );
  });

  it("includes remaining utility chrome keys for the Batch 4T migration", () => {
    expect(en.message.attachments.review).toBe("Review");
    expect(en.message.attachments.commentsOne).toBe("1 comment");
    expect(en.message.attachments.commentsMany).toBe("{{count}} comments");
    expect(en.message.attachments.textAttachment).toBe("Text attachment");
    expect(en.composer.attachments.element).toBe("Element");
    expect(en.workspace.hoverCard.scriptsAccessibility).toBe("Workspace scripts");
    expect(en.branchSwitcher.restoreStashTitle).toBe("Restore stashed changes?");
    expect(en.branchSwitcher.stashRestored).toBe("Stashed changes restored");
    expect(en.agentAutocomplete.searchingWorkspace).toBe("Searching workspace...");
    expect(en.agentAutocomplete.noCommands).toBe("No commands found");
    expect(en.agentAutocomplete.failedToLoad).toBe("Failed to load");
    expect(en.loadOlderHistory.failed).toBe("Couldn't load older history");
    expect(en.agentControls.thinking.extraHigh).toBe("Extra high");
    expect(en.agentControls.model.unknown).toBe("Unknown model");
    expect(en.panels.draft.creatingAgent).toBe("Creating agent");
  });

  it("includes shared default utility keys for the Batch 4U migration", () => {
    expect(en.common.actions.select).toBe("Select");
    expect(en.common.placeholders.search).toBe("Search...");
    expect(en.common.empty.noResults).toBe("No results found");
    expect(en.common.empty.noOptionsMatchSearch).toBe("No options match your search.");
    expect(en.toolCallDetails.subAgentActivity).toBe("Sub-agent activity");
    expect(en.panels.file.failedToLoadPreview).toBe("Failed to load file preview");
  });

  it("includes remaining local wrapper keys for the Batch 4W migration", () => {
    expect(en.workspace.header.toasts.branchNameUnavailable).toBe("Branch name not available");
    expect(en.startup.logs.loading).toBe("Loading daemon logs...");
    expect(en.startup.logs.unavailable).toBe("No daemon logs available.");
    expect(en.startup.logs.loadFailed).toBe("Unable to load daemon logs: {{message}}");
  });
});
