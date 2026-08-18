/**
 * The app-global Live Voice entry point: an icon button in the sidebar footer
 * that opens a menu. Idle, live voice occupies nothing but this icon — the strip
 * and the sidebar card only appear once a call exists. Diagnostics for why a
 * host can't take a call live in Settings → Diagnostics, not here.
 */

import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { AudioLines } from "lucide-react-native";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuHint,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  useDropdownMenuClose,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useLiveVoiceOptional } from "@/contexts/live-voice-context";
import { useLiveVoiceAvailability } from "@/live-voice/live-voice-availability";
import type { LiveVoiceHostAvailability } from "@/live-voice/live-voice-availability-policy";
import { resolveLiveVoiceStatusLabel } from "@/live-voice/live-voice-call-ui";
import { resolveLiveVoiceErrorMessage } from "@/live-voice/live-voice-error-message";
import { resolveLiveVoiceUnavailableMessage } from "@/live-voice/live-voice-unavailable-message";
import {
  LiveVoiceStartError,
  type LiveVoiceErrorInfo,
  type LiveVoicePhase,
} from "@/live-voice/live-voice-runtime";
import { ICON_SIZE, type Theme } from "@/styles/theme";

const ThemedAudioLines = withUnistyles(AudioLines);

const foregroundMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
// `statusSuccess` rather than `primary`: primary is near-black in the light
// themes, and a live call indicator has to read as live in every scheme.
const liveMapping = (theme: Theme) => ({ color: theme.colors.statusSuccess });
const dangerMapping = (theme: Theme) => ({ color: theme.colors.statusDanger });

/** Resting and hovered icon tint. A call in progress overrides the hover tint. */
function resolveIconMappings(input: { phase: LiveVoicePhase; hasCall: boolean }): {
  resting: (theme: Theme) => { color: string };
  hovered: (theme: Theme) => { color: string };
} {
  const { phase, hasCall } = input;
  if (phase === "error") {
    return { resting: dangerMapping, hovered: dangerMapping };
  }
  if (hasCall) {
    return { resting: liveMapping, hovered: liveMapping };
  }
  return { resting: foregroundMutedMapping, hovered: foregroundMapping };
}

function LiveVoiceHostMenuItem({
  host,
  isSelected,
  onSelect,
}: {
  host: LiveVoiceHostAvailability;
  isSelected: boolean;
  onSelect: (serverId: string) => void;
}) {
  const handleSelect = useCallback(() => {
    onSelect(host.serverId);
  }, [host.serverId, onSelect]);

  return (
    <DropdownMenuItem
      selected={isSelected}
      showSelectedCheck
      closeOnSelect={false}
      onSelect={handleSelect}
      testID={`live-voice-menu-host-${host.serverId}`}
    >
      {host.label}
    </DropdownMenuItem>
  );
}

function reportUnexpectedStartError(error: unknown): void {
  if (!(error instanceof LiveVoiceStartError)) {
    console.error("[LiveVoice] Failed to start session", error);
  }
}

/** In-call menu body: call status, terminal recovery, and the action that ends it. */
function LiveVoiceCallMenuItems({
  phase,
  isAudioBlocked,
  serverId,
  error,
}: {
  phase: LiveVoicePhase;
  isAudioBlocked: boolean;
  serverId: string | null;
  error: LiveVoiceErrorInfo | null;
}) {
  const liveVoice = useLiveVoiceOptional();
  const { t } = useTranslation();
  const closeMenu = useDropdownMenuClose();

  const handleStop = useCallback(() => {
    void liveVoice?.stop().catch((stopError: unknown) => {
      console.error("[LiveVoice] Failed to stop", stopError);
    });
  }, [liveVoice]);

  const handleDismiss = useCallback(() => {
    liveVoice?.dismiss();
  }, [liveVoice]);

  const handleRetry = useCallback(() => {
    if (!liveVoice || !serverId) {
      return;
    }
    void liveVoice.start(serverId).then(closeMenu).catch(reportUnexpectedStartError);
  }, [closeMenu, liveVoice, serverId]);

  const isTerminal = phase === "idle" || phase === "error";
  const errorMessage = error ? resolveLiveVoiceErrorMessage(error, t) : undefined;

  return (
    <>
      <DropdownMenuLabel testID="live-voice-menu-status">
        {resolveLiveVoiceStatusLabel({ phase, isAudioBlocked, t })}
      </DropdownMenuLabel>
      {isTerminal ? (
        <>
          {phase === "error" && serverId ? (
            <DropdownMenuItem
              closeOnSelect={false}
              description={errorMessage}
              onSelect={handleRetry}
              testID="live-voice-menu-retry"
            >
              {t("common.actions.retry")}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem
            description={phase === "error" && !serverId ? errorMessage : undefined}
            onSelect={handleDismiss}
            testID="live-voice-menu-dismiss"
          >
            {t("liveVoice.actions.dismiss")}
          </DropdownMenuItem>
        </>
      ) : (
        <DropdownMenuItem
          destructive
          disabled={phase === "stopping"}
          onSelect={handleStop}
          testID="live-voice-menu-stop"
        >
          {t("liveVoice.actions.stop")}
        </DropdownMenuItem>
      )}
    </>
  );
}

/** Idle menu body: pick a host when there is a choice, then start the call. */
function LiveVoiceStartMenuItems({
  hosts,
  selectedHost,
  onSelectHost,
}: {
  hosts: LiveVoiceHostAvailability[];
  selectedHost: LiveVoiceHostAvailability;
  onSelectHost: (serverId: string) => void;
}) {
  const liveVoice = useLiveVoiceOptional();
  const { t } = useTranslation();
  const closeMenu = useDropdownMenuClose();
  const { serverId } = selectedHost;

  const handleStart = useCallback(() => {
    if (!liveVoice) {
      return;
    }
    void liveVoice.start(serverId).then(closeMenu).catch(reportUnexpectedStartError);
  }, [closeMenu, liveVoice, serverId]);

  const hasHostChoice = hosts.length > 1;

  return (
    <>
      {hasHostChoice ? (
        <>
          <DropdownMenuLabel>{t("liveVoice.menu.hosts")}</DropdownMenuLabel>
          {hosts.map((host) => (
            <LiveVoiceHostMenuItem
              key={host.serverId}
              host={host}
              isSelected={host.serverId === serverId}
              onSelect={onSelectHost}
            />
          ))}
          <DropdownMenuSeparator />
        </>
      ) : null}
      <DropdownMenuItem
        closeOnSelect={false}
        onSelect={handleStart}
        description={hasHostChoice ? undefined : selectedHost.label}
        testID="live-voice-menu-start"
      >
        {t("liveVoice.actions.start")}
      </DropdownMenuItem>
    </>
  );
}

export function LiveVoiceFooterButton() {
  const liveVoice = useLiveVoiceOptional();
  const availability = useLiveVoiceAvailability();
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);

  if (!liveVoice) {
    return null;
  }

  const availableHosts = availability.kind === "available" ? availability.hosts : [];
  const selectedHost =
    availableHosts.find((host) => host.serverId === selectedServerId) ?? availableHosts[0] ?? null;

  const { phase, serverId, isAudioBlocked, error, closedCause } = liveVoice;
  const hasCall = phase !== "idle" || closedCause !== null;
  const iconMappings = resolveIconMappings({ phase, hasCall });

  return (
    <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
      <Tooltip delayDuration={300} enabledOnDesktop={!isOpen}>
        <TooltipTrigger asChild>
          <View>
            <DropdownMenuTrigger
              style={styles.trigger}
              testID="sidebar-live-voice-trigger"
              nativeID="sidebar-live-voice-trigger"
              accessibilityRole="button"
              accessibilityLabel={t("liveVoice.label")}
            >
              {({ hovered }) => (
                <ThemedAudioLines
                  size={ICON_SIZE.md}
                  uniProps={hovered ? iconMappings.hovered : iconMappings.resting}
                />
              )}
            </DropdownMenuTrigger>
          </View>
        </TooltipTrigger>
        <TooltipContent side="top" align="center" offset={8}>
          <Text style={styles.tooltipText}>{t("liveVoice.label")}</Text>
        </TooltipContent>
      </Tooltip>
      <DropdownMenuContent side="top" align="end" offset={8} width={260} testID="live-voice-menu">
        {hasCall ? (
          <LiveVoiceCallMenuItems
            phase={phase}
            isAudioBlocked={isAudioBlocked}
            serverId={serverId}
            error={error}
          />
        ) : null}
        {!hasCall && selectedHost ? (
          <LiveVoiceStartMenuItems
            hosts={availableHosts}
            selectedHost={selectedHost}
            onSelectHost={setSelectedServerId}
          />
        ) : null}
        {!hasCall && !selectedHost ? (
          <DropdownMenuHint testID="live-voice-menu-unavailable">
            {availability.kind === "unavailable"
              ? resolveLiveVoiceUnavailableMessage(availability.reason, t)
              : t("liveVoice.actions.unavailable")}
          </DropdownMenuHint>
        ) : null}
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
