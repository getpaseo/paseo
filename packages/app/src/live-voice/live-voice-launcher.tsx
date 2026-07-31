import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { AudioLines } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { DropdownTrigger } from "@/components/ui/dropdown-trigger";
import { useLiveVoiceOptional } from "@/contexts/live-voice-context";
import { useLiveVoiceAvailability } from "@/live-voice/live-voice-availability";
import type {
  LiveVoiceHostAvailability,
  LiveVoiceUnavailableReason,
} from "@/live-voice/live-voice-availability-policy";
import { LiveVoiceStartError } from "@/live-voice/live-voice-runtime";
import {
  isLiveVoiceBackgroundSessionSupported,
  type LiveVoiceSessionMode,
} from "@/live-voice/live-voice-session";

interface LiveVoiceLauncherProps {
  layout: "row" | "column";
}

const UNAVAILABLE_MESSAGE_KEYS: Record<LiveVoiceUnavailableReason, string> = {
  platform_unsupported: "liveVoice.unavailable.platform",
  no_hosts: "liveVoice.unavailable.noHosts",
  hosts_connecting: "liveVoice.unavailable.connecting",
  hosts_offline: "liveVoice.unavailable.offline",
  host_upgrade_required: "liveVoice.unavailable.upgrade",
};

function formatHostDiagnostics(hosts: LiveVoiceHostAvailability[]): string {
  return hosts
    .map((host) => {
      const version = host.version ?? "unknown";
      const feature = host.supportsLiveVoice === null ? "unknown" : String(host.supportsLiveVoice);
      return `${host.label}: ${host.connectionStatus}, version=${version}, liveVoice=${feature}`;
    })
    .join("; ");
}

function LiveVoiceHostPicker({
  hosts,
  selectedHost,
  onSelect,
}: {
  hosts: LiveVoiceHostAvailability[];
  selectedHost: LiveVoiceHostAvailability;
  onSelect: (serverId: string) => void;
}) {
  if (hosts.length === 1) {
    return (
      <Text numberOfLines={1} style={styles.hostLabel}>
        {selectedHost.label}
      </Text>
    );
  }

  return (
    <DropdownMenu>
      <DropdownTrigger accessibilityLabel={selectedHost.label} style={styles.hostPicker}>
        <Text numberOfLines={1} style={styles.hostPickerLabel}>
          {selectedHost.label}
        </Text>
      </DropdownTrigger>
      <DropdownMenuContent side="top" align="end" width={220}>
        {hosts.map((host) => (
          <LiveVoiceHostPickerItem
            key={host.serverId}
            host={host}
            isSelected={host.serverId === selectedHost.serverId}
            onSelect={onSelect}
          />
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function LiveVoiceHostPickerItem({
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
    <DropdownMenuItem selected={isSelected} showSelectedCheck onSelect={handleSelect}>
      {host.label}
    </DropdownMenuItem>
  );
}

export function LiveVoiceLauncher({ layout }: LiveVoiceLauncherProps) {
  const liveVoice = useLiveVoiceOptional();
  const availability = useLiveVoiceAvailability();
  const { t } = useTranslation();
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);

  const availableHosts = availability.kind === "available" ? availability.hosts : [];
  const selectedHost =
    availableHosts.find((host) => host.serverId === selectedServerId) ?? availableHosts[0] ?? null;

  const startLiveVoice = useCallback(
    (sessionMode: LiveVoiceSessionMode) => {
      if (!liveVoice || !selectedHost) {
        return;
      }
      void liveVoice.start(selectedHost.serverId, sessionMode).catch((error: unknown) => {
        if (!(error instanceof LiveVoiceStartError)) {
          console.error(`[LiveVoice] Failed to start ${sessionMode} session`, error);
        }
      });
    },
    [liveVoice, selectedHost],
  );

  const handleStartForeground = useCallback(() => {
    startLiveVoice("foreground");
  }, [startLiveVoice]);

  const handleStartBackground = useCallback(() => {
    startLiveVoice("background");
  }, [startLiveVoice]);

  const isRow = layout === "row";
  const identity = (
    <View style={styles.identity}>
      <Text style={styles.title}>{t("liveVoice.label")}</Text>
      <Text style={styles.scope}>{t("liveVoice.scope")}</Text>
    </View>
  );

  if (availability.kind === "available" && selectedHost) {
    return (
      <View style={isRow ? styles.launcherRow : styles.launcherColumn}>
        {identity}
        <View style={isRow ? styles.availableControlsRow : styles.availableControlsColumn}>
          <LiveVoiceHostPicker
            hosts={availableHosts}
            selectedHost={selectedHost}
            onSelect={setSelectedServerId}
          />
          <Button
            variant={isLiveVoiceBackgroundSessionSupported ? "secondary" : "default"}
            size="sm"
            leftIcon={AudioLines}
            onPress={handleStartForeground}
            style={isRow ? undefined : styles.fullWidthButton}
            testID="live-voice-global-start-foreground"
          >
            {t("liveVoice.actions.startForeground")}
          </Button>
          {isLiveVoiceBackgroundSessionSupported ? (
            <Button
              variant="default"
              size="sm"
              leftIcon={AudioLines}
              onPress={handleStartBackground}
              style={isRow ? undefined : styles.fullWidthButton}
              testID="live-voice-global-start-background"
            >
              {t("liveVoice.actions.startBackground")}
            </Button>
          ) : null}
        </View>
      </View>
    );
  }

  if (availability.kind === "available") {
    return null;
  }

  const unavailableMessage = t(UNAVAILABLE_MESSAGE_KEYS[availability.reason]);
  const diagnostics = formatHostDiagnostics(availability.hosts);

  return (
    <View style={isRow ? styles.launcherRow : styles.launcherColumn}>
      {identity}
      <View style={isRow ? styles.unavailableRow : styles.unavailableColumn}>
        <Button
          variant="secondary"
          size="sm"
          leftIcon={AudioLines}
          disabled
          style={isRow ? undefined : styles.fullWidthButton}
          testID="live-voice-global-unavailable"
        >
          {t("liveVoice.actions.unavailable")}
        </Button>
        <View style={styles.unavailableCopy}>
          <Text style={styles.unavailableMessage}>{unavailableMessage}</Text>
          {diagnostics.length > 0 ? (
            <Text style={styles.diagnostics}>
              {t("liveVoice.unavailable.debug", { details: diagnostics })}
            </Text>
          ) : null}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  launcherRow: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
  },
  launcherColumn: {
    gap: theme.spacing[2],
  },
  identity: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  scope: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  availableControlsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  availableControlsColumn: {
    gap: theme.spacing[2],
  },
  hostLabel: {
    maxWidth: 180,
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  hostPicker: {
    maxWidth: 180,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.surface3,
  },
  hostPickerLabel: {
    flexShrink: 1,
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foreground,
  },
  fullWidthButton: {
    alignSelf: "stretch",
  },
  unavailableRow: {
    flex: 2,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  unavailableColumn: {
    gap: theme.spacing[2],
  },
  unavailableCopy: {
    flexShrink: 1,
    gap: theme.spacing[1],
  },
  unavailableMessage: {
    fontFamily: theme.fontFamily.ui,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  diagnostics: {
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundExtraMuted,
  },
}));
