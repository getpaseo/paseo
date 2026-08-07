import { useCallback, useMemo, useState, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useRouter } from "expo-router";
import { ChevronDown, MessageCircle, SquareTerminal } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ProfileIcon } from "@/workspace-pins/launch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ICON_SIZE } from "@/styles/theme";
import {
  formatResolvedCommand,
  getTerminalProfileIcon,
  substitutePrompt,
} from "@getpaseo/protocol/terminal-profiles";
import type { TerminalProfile } from "@getpaseo/protocol/messages";
import { buildSettingsHostSectionRoute } from "@/utils/host-routes";
import type { Theme } from "@/styles/theme";
import {
  BLANK_TERMINAL_PROFILE_ID,
  CHAT_LAUNCH_TARGET,
  isBlankTerminalTarget,
  resolveLaunchProfile,
  terminalLaunchTarget,
  type LaunchTarget,
} from "./target";

const ThemedMessageCircle = withUnistyles(MessageCircle);
const ThemedSquareTerminal = withUnistyles(SquareTerminal);
const ThemedChevronDown = withUnistyles(ChevronDown);

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const extraMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundExtraMuted });

const chatIcon = <ThemedMessageCircle size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;
const blankTerminalIcon = <ThemedSquareTerminal size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;

/** Owns its own leading icon and select callback so neither is rebuilt per render of the menu. */
function LaunchProfileMenuItem({
  profile,
  selected,
  onSelect,
}: {
  profile: TerminalProfile;
  selected: boolean;
  onSelect: (profileId: string) => void;
}): ReactElement {
  const handleSelect = useCallback(() => onSelect(profile.id), [onSelect, profile.id]);
  const leading = useMemo(
    () => <ProfileIcon iconKey={getTerminalProfileIcon(profile)} />,
    [profile],
  );
  // What the profile runs before any prompt is typed, so the row says what it
  // actually launches rather than making you open settings to find out. Nested
  // in the label rather than passed as `description` so it sits inline right
  // after the name and truncates with it on one line.
  const commandPreview = useMemo(
    () => formatResolvedCommand(substitutePrompt(profile, "")),
    [profile],
  );
  return (
    <DropdownMenuItem
      testID={`new-workspace-launch-option-${profile.id}`}
      onSelect={handleSelect}
      selected={selected}
      leading={leading}
    >
      {profile.name} <Text style={styles.command}>{commandPreview}</Text>
    </DropdownMenuItem>
  );
}

export interface LaunchControlProps {
  serverId: string;
  target: LaunchTarget;
  onChange: (target: LaunchTarget) => void;
  profiles: readonly TerminalProfile[];
  disabled?: boolean;
  /**
   * The meta row's shared badge style. Passed in rather than redeclared so this
   * trigger stays pixel-identical to the project, host, and branch triggers it
   * sits beside; a local copy drifts the moment one of them changes.
   */
  badgePressableStyle: React.ComponentProps<typeof Pressable>["style"];
}

function TriggerIcon({
  target,
  profile,
}: {
  target: LaunchTarget;
  profile: TerminalProfile | null;
}): ReactElement {
  if (target.kind === "chat") {
    return <ThemedMessageCircle size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;
  }
  if (profile) {
    return <ProfileIcon iconKey={getTerminalProfileIcon(profile)} />;
  }
  return <ThemedSquareTerminal size={ICON_SIZE.sm} uniProps={mutedColorMapping} />;
}

/**
 * The meta-row control choosing what New workspace submits to: the chat agent,
 * or a terminal. One trigger shaped like every other chip on that row, opening
 * a menu whose Chat and Terminal groups are what keep a terminal profile named
 * "Codex" from reading as a chat Codex agent.
 */
export function LaunchControl({
  serverId,
  target,
  onChange,
  profiles,
  disabled = false,
  badgePressableStyle,
}: LaunchControlProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  const selectedProfile = useMemo(() => resolveLaunchProfile(target, profiles), [target, profiles]);

  // A profile's own name and logo say nothing about where it runs: a row
  // reading "(openai logo) Codex" is indistinguishable from a chat Codex agent.
  // Leading with the noun fixes that, and de-emphasising the profile name keeps
  // "Terminal" the thing you read first.
  const triggerLabel =
    target.kind === "chat" ? t("newWorkspace.launch.chat") : t("newWorkspace.launch.terminal");

  const selectChat = useCallback(() => onChange(CHAT_LAUNCH_TARGET), [onChange]);
  const selectBlankTerminal = useCallback(
    () => onChange(terminalLaunchTarget(BLANK_TERMINAL_PROFILE_ID)),
    [onChange],
  );
  const selectTerminalProfile = useCallback(
    (profileId: string) => onChange(terminalLaunchTarget(profileId)),
    [onChange],
  );
  const openProfileSettings = useCallback(() => {
    router.push(buildSettingsHostSectionRoute(serverId, "terminals"));
  }, [router, serverId]);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen} compactMode="sheet">
      {/* The trigger is the Pressable itself, styled by the meta row's shared
          badge style, so it lands pixel-identical to the project, host, and
          branch chips it sits beside. */}
      {/* MenuTrigger is not a forwardRef component and pins its own ref, so the
          tooltip anchors to a wrapping View instead. Suppressed while the menu
          is open so the two surfaces never overlap. */}
      <Tooltip delayDuration={300} enabledOnDesktop={!open}>
        <TooltipTrigger asChild>
          <View>
            <DropdownMenuTrigger
              testID="new-workspace-launch-trigger"
              disabled={disabled}
              style={badgePressableStyle}
              accessibilityRole="button"
              accessibilityLabel={t("newWorkspace.tooltips.launch")}
            >
              <View style={styles.iconBox}>
                <TriggerIcon target={target} profile={selectedProfile} />
              </View>
              <Text style={styles.label} numberOfLines={1}>
                {triggerLabel}
                {selectedProfile ? (
                  <Text style={styles.profileName}> {selectedProfile.name}</Text>
                ) : null}
              </Text>
              <ThemedChevronDown size={ICON_SIZE.sm} uniProps={extraMutedColorMapping} />
            </DropdownMenuTrigger>
          </View>
        </TooltipTrigger>
        <TooltipContent side="top" align="center" offset={8}>
          <Text style={styles.tooltipText}>{t("newWorkspace.tooltips.launch")}</Text>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent
        align="end"
        offset={8}
        width={260}
        sheetTitle={t("newWorkspace.launch.title")}
        testID="new-workspace-launch-menu"
      >
        {/* Chat leads with no label of its own: a group label over a single row
            is noise, and the sheet title already says what the menu is on
            compact. Terminal keeps its label because that grouping is what
            stops a profile named Codex reading as a chat Codex agent. */}
        <DropdownMenuItem
          testID="new-workspace-launch-option-chat"
          onSelect={selectChat}
          selected={target.kind === "chat"}
          leading={chatIcon}
        >
          {t("newWorkspace.launch.chat")}
        </DropdownMenuItem>
        <DropdownMenuLabel>{t("newWorkspace.launch.terminal")}</DropdownMenuLabel>
        <DropdownMenuItem
          testID="new-workspace-launch-option-blank"
          onSelect={selectBlankTerminal}
          selected={isBlankTerminalTarget(target)}
          leading={blankTerminalIcon}
        >
          {t("newWorkspace.launch.terminal")}
        </DropdownMenuItem>
        {profiles.map((profile) => (
          <LaunchProfileMenuItem
            key={profile.id}
            profile={profile}
            selected={selectedProfile?.id === profile.id}
            onSelect={selectTerminalProfile}
          />
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          testID="new-workspace-launch-manage-profiles"
          onSelect={openProfileSettings}
          muted
        >
          {t("newWorkspace.launch.manageProfiles")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const styles = StyleSheet.create((theme) => ({
  iconBox: {
    width: theme.iconSize.md,
    height: theme.iconSize.md,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  label: {
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
  },
  tooltipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.popoverForeground,
  },
  profileName: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundExtraMuted,
  },
  command: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
}));
