import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactElement,
  type ReactNode,
} from "react";
import { Pressable, ScrollView, Text, View, type PressableStateCallbackType } from "react-native";
import { useTranslation } from "react-i18next";
import {
  FileDiff,
  FolderTree,
  GitPullRequest,
  Globe,
  Pencil,
  Plus,
  SquarePen,
  SquareTerminal,
  type LucideIcon,
} from "lucide-react-native";
import { useRouter, type Href } from "expo-router";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import invariant from "tiny-invariant";
import { TerminalProfileIcon } from "@/components/terminal-profile-icon";
import { Shortcut } from "@/components/ui/shortcut";
import { isWeb } from "@/constants/platform";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useShortcutKeys } from "@/hooks/use-shortcut-keys";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import type { KeyboardActionDefinition } from "@/keyboard/keyboard-action-dispatcher";
import { usePaneContext, usePaneFocus } from "@/panels/pane-context";
import type { PanelRegistration } from "@/panels/panel-registry";
import { resolvePluginIcon } from "@/plugins/icons";
import { useInstalledPlugins } from "@/plugins/registry";
import type { InstalledPlugin } from "@/plugins/types";
import { ICON_SIZE, SPACING, type Theme } from "@/styles/theme";
import { buildSettingsHostSectionRoute } from "@/utils/host-routes";
import type { NewTabSelection } from "@/workspace-tabs/new-tab";
import type { PluginWorkspacePanelContribution } from "@getpaseo/plugin";
import type { TerminalProfile } from "@getpaseo/protocol/messages";
import {
  getTerminalProfileIcon,
  resolveTerminalProfiles,
} from "@getpaseo/protocol/terminal-profiles";

export interface NewTabLauncher {
  showChanges: boolean;
  showPullRequest: boolean;
  showBrowser: boolean;
  terminalDisabled: boolean;
  activate: (tabId: string, selection: NewTabSelection) => void;
}

const NewTabLauncherContext = createContext<NewTabLauncher | null>(null);

export function NewTabLauncherProvider({
  value,
  children,
}: {
  value: NewTabLauncher;
  children: ReactNode;
}) {
  return <NewTabLauncherContext.Provider value={value}>{children}</NewTabLauncherContext.Provider>;
}

const ThemedPlus = withUnistyles(Plus);
const ThemedPencil = withUnistyles(Pencil);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const extraMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundExtraMuted,
});
/** Every launcher row leads with the same glyph box so labels share one rail. */
const LAUNCHER_ICON_SIZE = ICON_SIZE.md;
const LAUNCHER_MAX_WIDTH = 380;
const EDIT_PROFILES_HIT_SIZE = ICON_SIZE.xs + SPACING[2];
const ROW_DATA_SET = { newTabLauncherRow: "true" };
const ROW_SELECTOR = '[data-new-tab-launcher-row="true"]';
const CHANGES_SELECTION: NewTabSelection = {
  kind: "target",
  target: { kind: "working_diff" },
};
const FILES_SELECTION: NewTabSelection = { kind: "target", target: { kind: "files" } };
const PULL_REQUEST_SELECTION: NewTabSelection = {
  kind: "target",
  target: { kind: "pull_request" },
};
const AGENT_SELECTION: NewTabSelection = { kind: "agent" };
const TERMINAL_SELECTION: NewTabSelection = { kind: "terminal" };
const BROWSER_SELECTION: NewTabSelection = { kind: "browser" };

function LauncherIcon({ Icon, color = "" }: { Icon: LucideIcon; color?: string }) {
  return <Icon size={LAUNCHER_ICON_SIZE} color={color} />;
}

const ThemedLauncherIcon = withUnistyles(LauncherIcon);

function LauncherShortcut({ actionId }: { actionId: string }): ReactElement | null {
  const keys = useShortcutKeys(actionId);
  return keys ? <Shortcut chord={keys} /> : null;
}

function rowStyle({
  pressed,
  hovered = false,
  focused = false,
}: PressableStateCallbackType & { hovered?: boolean; focused?: boolean }) {
  return [
    styles.row,
    (hovered || focused) && styles.rowHovered,
    focused && styles.rowFocused,
    pressed && styles.rowPressed,
  ];
}

function editProfilesStyle({ pressed, hovered }: PressableStateCallbackType) {
  return [styles.editProfiles, (hovered || pressed) && styles.editProfilesHovered];
}

function EditProfilesButton({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={editProfilesStyle}
      testID="workspace-new-tab-edit-terminal-profiles"
    >
      <View style={styles.editProfilesGlyph}>
        <ThemedPencil size={ICON_SIZE.xs} uniProps={extraMutedColorMapping} />
      </View>
    </Pressable>
  );
}

function LauncherRow({
  label,
  Icon,
  terminalIconKey,
  disabled,
  selection,
  shortcut,
  testID,
}: {
  label: string;
  Icon?: LucideIcon;
  terminalIconKey?: string;
  disabled?: boolean;
  selection: NewTabSelection;
  shortcut?: string;
  testID: string;
}) {
  const { tabId } = usePaneContext();
  const launcher = useContext(NewTabLauncherContext);
  invariant(launcher, "NewTabLauncherProvider is required");
  const handlePress = useCallback(() => {
    launcher.activate(tabId, selection);
  }, [launcher, selection, tabId]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      dataSet={ROW_DATA_SET}
      disabled={disabled}
      onPress={handlePress}
      style={rowStyle}
      tabIndex={-1}
      testID={testID}
    >
      {Icon ? <ThemedLauncherIcon Icon={Icon} uniProps={mutedColorMapping} /> : null}
      {terminalIconKey ? (
        <TerminalProfileIcon iconKey={terminalIconKey} size={LAUNCHER_ICON_SIZE} />
      ) : null}
      <Text numberOfLines={1} style={styles.rowLabel}>
        {label}
      </Text>
      {shortcut ? <LauncherShortcut actionId={shortcut} /> : null}
    </Pressable>
  );
}

function TerminalProfileLauncherRow({
  profile,
  disabled,
}: {
  profile: TerminalProfile;
  disabled: boolean;
}) {
  const selection = useMemo<NewTabSelection>(() => ({ kind: "terminal", profile }), [profile]);
  return (
    <LauncherRow
      label={profile.name}
      terminalIconKey={getTerminalProfileIcon(profile)}
      disabled={disabled}
      selection={selection}
      testID={`workspace-new-tab-terminal-profile-${profile.id}`}
    />
  );
}

function PluginLauncherRow({
  pluginId,
  panel,
}: {
  pluginId: string;
  panel: PluginWorkspacePanelContribution;
}) {
  const selection = useMemo<NewTabSelection>(
    () => ({
      kind: "target",
      target: { kind: "plugin", pluginId, panelId: panel.id, context: "workspace" },
    }),
    [panel.id, pluginId],
  );
  return (
    <LauncherRow
      label={panel.title}
      Icon={resolvePluginIcon(panel.icon)}
      selection={selection}
      testID={`workspace-new-tab-plugin-${pluginId}-${panel.id}`}
    />
  );
}

function collectWorkspacePluginPanels(plugins: InstalledPlugin[], serverId: string) {
  const result: Array<{ pluginId: string; panel: PluginWorkspacePanelContribution }> = [];
  for (const plugin of plugins) {
    if (plugin.serverId !== serverId) continue;
    for (const panel of plugin.workspacePanels) {
      if (panel.context === "workspace") {
        result.push({ pluginId: plugin.id, panel });
      }
    }
  }
  return result;
}

function useNewTabDescriptor() {
  const { t } = useTranslation();
  const label = t("workspace.tabs.actions.newTab");
  return {
    label,
    subtitle: label,
    tooltip: label,
    titleState: "ready" as const,
    icon: ThemedPlus,
    statusBucket: null,
  };
}

const NewTabPanel = memo(function NewTabPanel(): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const { serverId, tabId } = usePaneContext();
  const { isInteractive, focusPane } = usePaneFocus();
  const launcher = useContext(NewTabLauncherContext);
  invariant(launcher, "NewTabLauncherProvider is required");
  const { config } = useDaemonConfig(serverId);
  const plugins = useInstalledPlugins();
  const containerRef = useRef<View | null>(null);
  const profiles = useMemo(
    () => resolveTerminalProfiles(config?.terminalProfiles),
    [config?.terminalProfiles],
  );
  const pluginPanels = useMemo(
    () => collectWorkspacePluginPanels(plugins, serverId),
    [plugins, serverId],
  );
  const editTerminalProfiles = useCallback(() => {
    router.push(buildSettingsHostSectionRoute(serverId, "terminals") as Href);
  }, [router, serverId]);

  useEffect(() => {
    if (!isWeb || !isInteractive) return;
    const container: unknown = containerRef.current;
    if (!(container instanceof HTMLElement)) return;
    const webContainer = container as HTMLElement;

    function rows() {
      return Array.from(webContainer.querySelectorAll(ROW_SELECTOR)) as HTMLElement[];
    }
    function focusFirstRow() {
      rows()[0]?.focus({ preventScroll: true });
    }
    function handlePointerDown(event: PointerEvent) {
      focusPane();
      if (!(event.target instanceof Element) || !event.target.closest(ROW_SELECTOR)) {
        requestAnimationFrame(focusFirstRow);
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      const availableRows = rows();
      const currentIndex = availableRows.findIndex((row) => row === document.activeElement);
      let direction = 0;
      if (event.key === "ArrowDown") {
        direction = 1;
      } else if (event.key === "ArrowUp") {
        direction = -1;
      }
      if (direction !== 0 && availableRows.length > 0) {
        event.preventDefault();
        let start = currentIndex;
        if (currentIndex < 0) {
          start = direction > 0 ? -1 : 0;
        }
        const nextIndex = (start + direction + availableRows.length) % availableRows.length;
        availableRows[nextIndex]?.focus();
      }
      if (event.key === "Enter" && currentIndex >= 0) {
        event.preventDefault();
        availableRows[currentIndex]?.click();
      }
    }

    webContainer.addEventListener("pointerdown", handlePointerDown, true);
    webContainer.addEventListener("keydown", handleKeyDown);
    focusFirstRow();
    return () => {
      webContainer.removeEventListener("pointerdown", handlePointerDown, true);
      webContainer.removeEventListener("keydown", handleKeyDown);
    };
  }, [focusPane, isInteractive]);

  const activate = useCallback(
    (selection: NewTabSelection) => launcher.activate(tabId, selection),
    [launcher, tabId],
  );
  const handleKeyboardAction = useCallback(
    (action: KeyboardActionDefinition): boolean => {
      if (action.id === "workspace.agent.new" || action.id === "workspace.tab.target.agent") {
        activate({ kind: "agent" });
        return true;
      }
      if (action.id === "workspace.terminal.new") {
        activate({ kind: "terminal" });
        return true;
      }
      if (action.id === "workspace.browser.new" || action.id === "workspace.tab.target.browser") {
        if (launcher.showBrowser) {
          activate({ kind: "browser" });
        }
        return true;
      }
      if (action.id === "workspace.tab.target.changes") {
        if (launcher.showChanges) {
          activate({ kind: "target", target: { kind: "working_diff" } });
        }
        return true;
      }
      if (action.id === "workspace.tab.target.files") {
        activate({ kind: "target", target: { kind: "files" } });
        return true;
      }
      return false;
    },
    [activate, launcher.showBrowser, launcher.showChanges],
  );
  useKeyboardActionHandler({
    handlerId: `new-tab:${tabId}`,
    actions: [
      "workspace.agent.new",
      "workspace.terminal.new",
      "workspace.browser.new",
      "workspace.tab.target.agent",
      "workspace.tab.target.browser",
      "workspace.tab.target.changes",
      "workspace.tab.target.files",
    ],
    enabled: isInteractive,
    priority: 250,
    handle: handleKeyboardAction,
  });

  return (
    <View ref={containerRef} style={styles.container} testID="workspace-new-tab-panel">
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.rail}>
          <View style={styles.group}>
            {launcher.showChanges ? (
              <LauncherRow
                label={t("workspace.tabs.actions.changes")}
                Icon={FileDiff}
                selection={CHANGES_SELECTION}
                shortcut="workspace-tab-target-changes"
                testID="workspace-new-tab-changes"
              />
            ) : null}
            <LauncherRow
              label={t("workspace.tabs.actions.files")}
              Icon={FolderTree}
              selection={FILES_SELECTION}
              shortcut="workspace-tab-target-files"
              testID="workspace-new-tab-files"
            />
            {launcher.showPullRequest ? (
              <LauncherRow
                label={t("workspace.tabs.actions.pullRequest")}
                Icon={GitPullRequest}
                selection={PULL_REQUEST_SELECTION}
                testID="workspace-new-tab-pull-request"
              />
            ) : null}
            <LauncherRow
              label={t("workspace.tabs.fallback.agent")}
              Icon={SquarePen}
              selection={AGENT_SELECTION}
              shortcut="workspace-tab-target-agent"
              testID="workspace-new-tab-agent"
            />
            <LauncherRow
              label={t("workspace.tabs.fallback.terminal")}
              Icon={SquareTerminal}
              disabled={launcher.terminalDisabled}
              selection={TERMINAL_SELECTION}
              shortcut="workspace-terminal-new"
              testID="workspace-new-tab-terminal"
            />
            {launcher.showBrowser ? (
              <LauncherRow
                label={t("workspace.tabs.fallback.browser")}
                Icon={Globe}
                selection={BROWSER_SELECTION}
                shortcut="workspace-tab-target-browser"
                testID="workspace-new-tab-browser"
              />
            ) : null}
            {pluginPanels.map(({ pluginId, panel }) => (
              <PluginLauncherRow
                key={`${pluginId}:${panel.id}`}
                pluginId={pluginId}
                panel={panel}
              />
            ))}
          </View>
          {profiles.length > 0 ? (
            <View style={styles.group}>
              <View style={styles.groupHeader}>
                <Text style={styles.groupLabel}>
                  {t("workspace.tabs.actions.terminalProfilesMenu")}
                </Text>
                <EditProfilesButton
                  label={t("workspace.tabs.actions.editTerminalProfiles")}
                  onPress={editTerminalProfiles}
                />
              </View>
              {profiles.map((profile) => (
                <TerminalProfileLauncherRow
                  key={profile.id}
                  disabled={launcher.terminalDisabled}
                  profile={profile}
                />
              ))}
            </View>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
});

export const newTabPanelRegistration: PanelRegistration<"new_tab"> = {
  kind: "new_tab",
  resourceKey: () => "new_tab",
  component: NewTabPanel,
  useDescriptor: useNewTabDescriptor,
};

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[6],
  },
  rail: {
    width: "100%",
    maxWidth: LAUNCHER_MAX_WIDTH,
    gap: theme.spacing[12],
  },
  group: {
    gap: theme.spacing[1],
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 44,
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    borderWidth: theme.borderWidth[1],
    borderColor: "transparent",
    outlineWidth: 0,
    outlineColor: "transparent",
    backgroundColor: theme.colors.surface1,
  },
  rowHovered: { backgroundColor: theme.colors.surface2 },
  rowFocused: { borderColor: theme.colors.borderAccent },
  rowPressed: { opacity: 0.85 },
  rowLabel: { flex: 1, color: theme.colors.foreground },
  // The rows below establish both rails at `spacing[3] + borderWidth[1]`: their icon
  // glyphs on the left, their shortcut badges on the right. The label sits on the
  // first directly; the pencil's own padding is subtracted so its glyph — not its
  // hover box — lands on the second.
  groupHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingLeft: theme.spacing[3] + theme.borderWidth[1],
    // Optical: the pencil's stroke stops short of its own box, so the box rail
    // needs a pixel back to put the ink on the rows' trailing rail.
    paddingRight: theme.spacing[3] + theme.borderWidth[1] + 3,
    marginBottom: theme.spacing[1],
  },
  groupLabel: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
    // Without an explicit line height the font's ascent/descent split the text box
    // unevenly and the label rides above the pencil beside it.
    lineHeight: EDIT_PROFILES_HIT_SIZE,
  },
  // The box is the hover target; the negative margin cancels its growth on every
  // side, so its layout footprint stays the glyph and the header keeps its height.
  editProfiles: {
    width: EDIT_PROFILES_HIT_SIZE,
    height: EDIT_PROFILES_HIT_SIZE,
    margin: -(EDIT_PROFILES_HIT_SIZE - ICON_SIZE.xs) / 2,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
    outlineWidth: 0,
    outlineColor: "transparent",
  },
  // Opacity sits on the whole glyph, not per path — the pencil's two strokes
  // overlap and would render unevenly if each faded on its own.
  editProfilesGlyph: {
    opacity: theme.opacity[50],
  },
  editProfilesHovered: {
    backgroundColor: theme.colors.surface2,
  },
}));
