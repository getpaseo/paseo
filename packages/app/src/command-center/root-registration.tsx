import { useMemo } from "react";
import { router, type Href } from "expo-router";
import { useTranslation } from "react-i18next";
import {
  CalendarClock,
  FolderPlus,
  History,
  Home,
  Keyboard,
  Plus,
  Settings,
} from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { getIsElectronRuntime } from "@/constants/layout";
import { useKeyboardShortcutOverrides } from "@/hooks/use-keyboard-shortcut-overrides";
import { useOpenAddProject } from "@/hooks/use-open-add-project";
import { keyboardActionDispatcher } from "@/keyboard/keyboard-action-dispatcher";
import { resolveShortcutKeysForAction } from "@/keyboard/keyboard-shortcuts";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { clearCommandCenterFocusRestoreElement } from "@/utils/command-center-focus-restore";
import {
  buildOpenProjectRoute,
  buildSchedulesRoute,
  buildSessionsRoute,
  buildSettingsRoute,
} from "@/utils/host-routes";
import { getShortcutOs } from "@/utils/shortcut-platform";
import type { CommandCenterContribution, CommandCenterIconProps } from "./contributions";
import { useCommandCenterActions } from "./provider";

const ThemedPlus = withUnistyles(Plus, (theme) => ({ color: theme.colors.foregroundMuted }));
const ThemedFolderPlus = withUnistyles(FolderPlus, (theme) => ({
  color: theme.colors.foregroundMuted,
}));
const ThemedHistory = withUnistyles(History, (theme) => ({
  color: theme.colors.foregroundMuted,
}));
const ThemedCalendarClock = withUnistyles(CalendarClock, (theme) => ({
  color: theme.colors.foregroundMuted,
}));
const ThemedKeyboard = withUnistyles(Keyboard, (theme) => ({
  color: theme.colors.foregroundMuted,
}));
const ThemedSettings = withUnistyles(Settings, (theme) => ({
  color: theme.colors.foregroundMuted,
}));
const ThemedHome = withUnistyles(Home, (theme) => ({ color: theme.colors.foregroundMuted }));

function PlusIcon({ size }: CommandCenterIconProps) {
  return <ThemedPlus size={size} strokeWidth={2.4} />;
}

function AddProjectIcon({ size }: CommandCenterIconProps) {
  return <ThemedFolderPlus size={size} strokeWidth={2.2} />;
}

function SettingsIcon({ size }: CommandCenterIconProps) {
  return <ThemedSettings size={size} strokeWidth={2.2} />;
}

function HistoryIcon({ size }: CommandCenterIconProps) {
  return <ThemedHistory size={size} strokeWidth={2.2} />;
}

function SchedulesIcon({ size }: CommandCenterIconProps) {
  return <ThemedCalendarClock size={size} strokeWidth={2.2} />;
}

function KeyboardIcon({ size }: CommandCenterIconProps) {
  return <ThemedKeyboard size={size} strokeWidth={2.2} />;
}

function HomeIcon({ size }: CommandCenterIconProps) {
  return <ThemedHome size={size} strokeWidth={2.2} />;
}

export function CommandCenterRootActions() {
  const { t } = useTranslation();
  const { overrides } = useKeyboardShortcutOverrides();
  const openAddProject = useOpenAddProject();
  const settingsRoute = useMemo<Href>(() => buildSettingsRoute(), []);
  const homeRoute = useMemo<Href>(() => buildOpenProjectRoute(), []);
  const sessionsRoute = useMemo<Href>(() => buildSessionsRoute(), []);
  const schedulesRoute = useMemo<Href>(() => buildSchedulesRoute(), []);
  const setShortcutsDialogOpen = useKeyboardShortcutsStore((state) => state.setShortcutsDialogOpen);
  const shortcutPlatform = useMemo(
    () => ({ isMac: getShortcutOs() === "mac", isDesktop: getIsElectronRuntime() }),
    [],
  );
  const actions = useMemo<CommandCenterContribution[]>(
    () => [
      {
        id: "add-project",
        group: "actions",
        groupRank: 0,
        rank: 0,
        keywords: ["open", "project", "folder", "workspace", "repo"],
        visibility: "query",
        run: () => {
          clearCommandCenterFocusRestoreElement();
          openAddProject();
        },
        presentation: {
          kind: "action",
          title: t("shell.commandCenter.addProject"),
          sectionTitle: t("shell.commandCenter.actions"),
          icon: AddProjectIcon,
          // The help id remains "new-agent" because user overrides are keyed by its binding id.
          shortcutKeys:
            resolveShortcutKeysForAction("new-agent", overrides, shortcutPlatform) ?? undefined,
        },
      },
      {
        id: "new-workspace",
        group: "actions",
        groupRank: 0,
        rank: 1,
        keywords: ["new", "workspace", "worktree", "branch"],
        visibility: "always",
        run: () => {
          keyboardActionDispatcher.dispatch({ id: "workspace.new", scope: "sidebar" });
        },
        presentation: {
          kind: "action",
          title: t("sidebar.actions.newWorkspace"),
          sectionTitle: t("shell.commandCenter.actions"),
          icon: PlusIcon,
          shortcutKeys:
            resolveShortcutKeysForAction("new-workspace", overrides, shortcutPlatform) ?? undefined,
        },
      },
      {
        id: "home",
        group: "actions",
        groupRank: 0,
        rank: 2,
        keywords: ["home", "start", "import", "session", "pair", "device", "providers"],
        visibility: "query",
        run: () => {
          clearCommandCenterFocusRestoreElement();
          router.push(homeRoute);
        },
        presentation: {
          kind: "action",
          title: t("shell.commandCenter.home"),
          sectionTitle: t("shell.commandCenter.actions"),
          icon: HomeIcon,
        },
      },
      {
        id: "history",
        group: "actions",
        groupRank: 0,
        rank: 3,
        keywords: ["history", "sessions", "recent"],
        visibility: "always",
        run: () => {
          clearCommandCenterFocusRestoreElement();
          router.push(sessionsRoute);
        },
        presentation: {
          kind: "action",
          title: t("sidebar.sections.sessions"),
          sectionTitle: t("shell.commandCenter.actions"),
          icon: HistoryIcon,
        },
      },
      {
        id: "schedules",
        group: "actions",
        groupRank: 0,
        rank: 4,
        keywords: ["schedules", "scheduled", "automation", "recurring"],
        visibility: "always",
        run: () => {
          clearCommandCenterFocusRestoreElement();
          router.push(schedulesRoute);
        },
        presentation: {
          kind: "action",
          title: t("sidebar.sections.schedules"),
          sectionTitle: t("shell.commandCenter.actions"),
          icon: SchedulesIcon,
        },
      },
      {
        id: "settings",
        group: "actions",
        groupRank: 0,
        rank: 5,
        keywords: ["settings", "preferences", "config", "configuration"],
        visibility: "always",
        run: () => {
          clearCommandCenterFocusRestoreElement();
          router.push(settingsRoute);
        },
        presentation: {
          kind: "action",
          title: t("sidebar.actions.settings"),
          sectionTitle: t("shell.commandCenter.actions"),
          icon: SettingsIcon,
          shortcutKeys:
            resolveShortcutKeysForAction("toggle-settings", overrides, shortcutPlatform) ??
            undefined,
        },
      },
      {
        id: "keyboard-shortcuts",
        group: "actions",
        groupRank: 0,
        rank: 6,
        keywords: ["keyboard", "shortcuts", "keys", "hotkeys"],
        visibility: "always",
        run: () => setShortcutsDialogOpen(true),
        presentation: {
          kind: "action",
          title: t("sidebar.help.shortcuts"),
          sectionTitle: t("shell.commandCenter.actions"),
          icon: KeyboardIcon,
          shortcutKeys:
            resolveShortcutKeysForAction("show-shortcuts", overrides, shortcutPlatform) ??
            undefined,
        },
      },
    ],
    [
      homeRoute,
      openAddProject,
      overrides,
      schedulesRoute,
      sessionsRoute,
      setShortcutsDialogOpen,
      settingsRoute,
      shortcutPlatform,
      t,
    ],
  );

  useCommandCenterActions({ sourceId: "root", enabled: true, actions });
  return null;
}
