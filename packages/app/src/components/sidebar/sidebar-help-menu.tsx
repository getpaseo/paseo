import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { Activity, CircleHelp, Keyboard } from "lucide-react-native";
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
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { formatVersionWithPrefix } from "@/desktop/updates/desktop-updates";
import { resolveAppVersion } from "@/utils/app-version";
import { openExternalUrl } from "@/utils/open-external-url";

const DISCORD_URL = "https://discord.gg/jz8T2uahpH";
const GITHUB_ISSUE_URL = "https://github.com/getpaseo/paseo/issues/new";
const ThemedActivity = withUnistyles(Activity);
const ThemedCircleHelp = withUnistyles(CircleHelp);
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

export function SidebarHelpMenu() {
  const { t } = useTranslation();
  const isCompactLayout = useIsCompactFormFactor();
  const openAppDiagnostic = useAppDiagnosticStore((state) => state.open);
  const setShortcutsDialogOpen = useKeyboardShortcutsStore((state) => state.setShortcutsDialogOpen);
  const [open, setOpen] = useState(false);
  const showKeyboardShortcuts = !isNative && !isCompactLayout;
  const version = formatVersionWithPrefix(resolveAppVersion());

  const openKeyboardShortcuts = useCallback(() => {
    setShortcutsDialogOpen(true);
  }, [setShortcutsDialogOpen]);

  const openDiscord = useCallback(() => {
    void openExternalUrl(DISCORD_URL);
  }, []);

  const openGitHubIssue = useCallback(() => {
    void openExternalUrl(GITHUB_ISSUE_URL);
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
        <DropdownMenuLabel>{t("sidebar.help.troubleshoot")}</DropdownMenuLabel>
        <DropdownMenuItem
          testID="sidebar-help-diagnostics"
          description={t("sidebar.help.diagnosticsDescription")}
          leading={diagnosticLeadingIcon}
          onSelect={openAppDiagnostic}
        >
          {t("sidebar.help.diagnostics")}
        </DropdownMenuItem>
        {showKeyboardShortcuts ? (
          <DropdownMenuItem
            testID="sidebar-help-shortcuts"
            description={t("sidebar.help.shortcutsDescription")}
            leading={shortcutsLeadingIcon}
            onSelect={openKeyboardShortcuts}
          >
            {t("sidebar.help.shortcuts")}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t("sidebar.help.reportIssue")}</DropdownMenuLabel>
        <DropdownMenuItem
          testID="sidebar-help-discord"
          description={t("sidebar.help.discordDescription")}
          leading={discordLeadingIcon}
          onSelect={openDiscord}
        >
          {t("sidebar.help.discord")}
        </DropdownMenuItem>
        <DropdownMenuItem
          testID="sidebar-help-github"
          description={t("sidebar.help.githubDescription")}
          leading={githubLeadingIcon}
          onSelect={openGitHubIssue}
        >
          {t("sidebar.help.github")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuHint testID="sidebar-help-version">
          {t("sidebar.help.version", { version })}
        </DropdownMenuHint>
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
}));
