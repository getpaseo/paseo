import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { Activity, CircleHelp, Gift, Keyboard } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { DiscordIcon } from "@/components/icons/discord-icon";
import { GitHubIcon } from "@/components/icons/github-icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuHint,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative } from "@/constants/platform";
import { useAppDiagnosticStore } from "@/diagnostics/store";
import { useHostRuntimeIsConnected, useHosts } from "@/runtime/host-runtime";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { useSessionStore } from "@/stores/session-store";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import type { HostProfile } from "@/types/host-connection";
import { formatVersionWithPrefix } from "@/desktop/updates/desktop-updates";
import { resolveAppVersion } from "@/utils/app-version";
import { openExternalUrl } from "@/utils/open-external-url";

const DISCORD_URL = "https://discord.gg/jz8T2uahpH";
const GITHUB_ISSUE_URL = "https://github.com/getpaseo/paseo/issues/new";
const CHANGELOG_URL = "https://paseo.sh/changelog";
const ThemedActivity = withUnistyles(Activity);
const ThemedCircleHelp = withUnistyles(CircleHelp);
const ThemedGift = withUnistyles(Gift);
const ThemedKeyboard = withUnistyles(Keyboard);
const ThemedDiscordIcon = withUnistyles(DiscordIcon);
const ThemedGitHubIcon = withUnistyles(GitHubIcon);
const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
const diagnosticLeadingIcon = (
  <ThemedActivity size={ICON_SIZE.sm} uniProps={foregroundMutedColorMapping} />
);
const shortcutsLeadingIcon = (
  <ThemedKeyboard size={ICON_SIZE.sm} uniProps={foregroundMutedColorMapping} />
);
const discordLeadingIcon = (
  <ThemedDiscordIcon size={ICON_SIZE.sm} uniProps={foregroundMutedColorMapping} />
);
const githubLeadingIcon = (
  <ThemedGitHubIcon size={ICON_SIZE.sm} uniProps={foregroundMutedColorMapping} />
);
const changelogLeadingIcon = (
  <ThemedGift size={ICON_SIZE.sm} uniProps={foregroundMutedColorMapping} />
);

function HostVersionHint({ host }: { host: HostProfile }) {
  const { t } = useTranslation();
  const isConnected = useHostRuntimeIsConnected(host.serverId);
  const daemonVersion = useSessionStore(
    (state) => state.sessions[host.serverId]?.serverInfo?.version ?? null,
  );
  const version = isConnected
    ? formatVersionWithPrefix(daemonVersion)
    : t("settings.about.offline");

  return (
    <DropdownMenuHint
      style={styles.versionHint}
      testID={`sidebar-help-host-version-${host.serverId}`}
    >
      {host.label} {version}
    </DropdownMenuHint>
  );
}

export function SidebarHelpMenu() {
  const { t } = useTranslation();
  const isCompactLayout = useIsCompactFormFactor();
  const openAppDiagnostic = useAppDiagnosticStore((state) => state.open);
  const setShortcutsDialogOpen = useKeyboardShortcutsStore((state) => state.setShortcutsDialogOpen);
  const [open, setOpen] = useState(false);
  const showKeyboardShortcuts = !isNative && !isCompactLayout;
  const version = formatVersionWithPrefix(resolveAppVersion());
  const hosts = useHosts();

  const openKeyboardShortcuts = useCallback(() => {
    setShortcutsDialogOpen(true);
  }, [setShortcutsDialogOpen]);

  const openDiscord = useCallback(() => {
    void openExternalUrl(DISCORD_URL);
  }, []);

  const openGitHubIssue = useCallback(() => {
    void openExternalUrl(GITHUB_ISSUE_URL);
  }, []);

  const openChangelog = useCallback(() => {
    void openExternalUrl(CHANGELOG_URL);
  }, []);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tooltip delayDuration={300} enabledOnDesktop={!open}>
        <TooltipTrigger asChild>
          <View>
            <DropdownMenuTrigger
              style={styles.trigger}
              testID="sidebar-help"
              accessibilityRole="button"
              accessibilityLabel={t("sidebar.help.trigger")}
            >
              {({ hovered }) => (
                <ThemedCircleHelp
                  size={ICON_SIZE.md}
                  uniProps={hovered ? foregroundColorMapping : foregroundMutedColorMapping}
                />
              )}
            </DropdownMenuTrigger>
          </View>
        </TooltipTrigger>
        <TooltipContent side="top" align="center" offset={8}>
          <Text style={styles.tooltipText}>{t("sidebar.help.trigger")}</Text>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent side="top" align="end" offset={8} width={280} testID="sidebar-help-menu">
        <DropdownMenuLabel>{t("sidebar.help.sectionHelp")}</DropdownMenuLabel>
        {showKeyboardShortcuts ? (
          <DropdownMenuItem
            testID="sidebar-help-shortcuts"
            leading={shortcutsLeadingIcon}
            onSelect={openKeyboardShortcuts}
          >
            {t("sidebar.help.shortcuts")}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          testID="sidebar-help-changelog"
          leading={changelogLeadingIcon}
          onSelect={openChangelog}
        >
          {t("sidebar.help.whatsNew")}
        </DropdownMenuItem>
        <DropdownMenuItem
          testID="sidebar-help-diagnostics"
          leading={diagnosticLeadingIcon}
          onSelect={openAppDiagnostic}
        >
          {t("sidebar.help.diagnostics")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t("sidebar.help.reportIssue")}</DropdownMenuLabel>
        <DropdownMenuItem
          testID="sidebar-help-discord"
          leading={discordLeadingIcon}
          onSelect={openDiscord}
        >
          {t("sidebar.help.discord")}
        </DropdownMenuItem>
        <DropdownMenuItem
          testID="sidebar-help-github"
          leading={githubLeadingIcon}
          onSelect={openGitHubIssue}
        >
          {t("sidebar.help.github")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <View style={styles.versionList}>
          <DropdownMenuHint style={styles.versionHint} testID="sidebar-help-version">
            {t("sidebar.help.version", { version })}
          </DropdownMenuHint>
          {hosts.map((host) => (
            <HostVersionHint key={host.serverId} host={host} />
          ))}
        </View>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[1],
  },
  tooltipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.popoverForeground,
  },
  versionList: {
    gap: theme.spacing[1],
    paddingVertical: theme.spacing[2],
  },
  versionHint: {
    paddingVertical: 0,
  },
}));
