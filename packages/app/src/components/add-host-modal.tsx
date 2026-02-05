import { useCallback, useMemo, useRef, useState } from "react";
import { Alert, Pressable, Text, TextInput, View } from "react-native";
import { StyleSheet, UnistylesRuntime, useUnistyles } from "react-native-unistyles";
import { BottomSheetTextInput } from "@gorhom/bottom-sheet";
import { Link2 } from "lucide-react-native";
import { useDaemonRegistry, type HostProfile } from "@/contexts/daemon-registry-context";
import { normalizeHostPort } from "@/utils/daemon-endpoints";
import { DaemonConnectionTestError, probeDaemonEndpoint } from "@/utils/test-daemon-connection";
import { AdaptiveModalSheet } from "./adaptive-modal-sheet";

const styles = StyleSheet.create((theme) => ({
  field: {
    gap: theme.spacing[2],
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  input: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    color: theme.colors.foreground,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  actions: {
    flexDirection: "row",
    gap: theme.spacing[3],
    marginTop: theme.spacing[2],
  },
  button: {
    flex: 1,
    paddingVertical: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface2,
  },
  primaryButton: {
    backgroundColor: theme.colors.palette.blue[500],
  },
  buttonText: {
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.semibold,
  },
  primaryButtonText: {
    color: theme.colors.palette.white,
  },
  helper: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
  },
  connectRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
  },
}));

function isHostPortOnly(raw: string): boolean {
  return !raw.includes("://") && !raw.includes("/");
}

function normalizeTransportMessage(message: string | null | undefined): string | null {
  if (!message) return null;
  const trimmed = message.trim();
  if (!trimmed) return null;
  return trimmed;
}

function formatTechnicalTransportDetails(details: Array<string | null>): string | null {
  const unique = Array.from(
    new Set(
      details
        .map((value) => normalizeTransportMessage(value))
        .filter((value): value is string => Boolean(value))
        .map((value) => value.trim())
        .filter((value) => value.length > 0)
    )
  );

  if (unique.length === 0) return null;

  const allGeneric = unique.every((value) => {
    const lower = value.toLowerCase();
    return lower === "transport error" || lower === "transport closed";
  });

  if (allGeneric) {
    return `${unique[0]} (no additional details provided)`;
  }

  return unique.join(" — ");
}

function buildConnectionFailureCopy(endpoint: string, error: unknown): { title: string; detail: string | null; raw: string | null } {
  const title = `We failed to connect to ${endpoint}.`;

  const raw = (() => {
    if (error instanceof DaemonConnectionTestError) {
      return (
        formatTechnicalTransportDetails([error.reason, error.lastError]) ??
        normalizeTransportMessage(error.message)
      );
    }
    if (error instanceof Error) {
      return normalizeTransportMessage(error.message);
    }
    return null;
  })();

  const rawLower = raw?.toLowerCase() ?? "";
  let detail: string | null = null;

  if (rawLower.includes("timed out")) {
    detail = "Connection timed out. Check the host/port and your network.";
  } else if (
    rawLower.includes("econnrefused") ||
    rawLower.includes("connection refused") ||
    rawLower.includes("err_connection_refused")
  ) {
    detail = "Connection was refused. Is the daemon running on that host and port?";
  } else if (rawLower.includes("enotfound") || rawLower.includes("not found")) {
    detail = "Host not found. Check the hostname and try again.";
  } else if (rawLower.includes("ehostunreach") || rawLower.includes("host is unreachable")) {
    detail = "Host is unreachable. Check your network and firewall.";
  } else if (rawLower.includes("certificate") || rawLower.includes("tls") || rawLower.includes("ssl")) {
    detail = "TLS/certificate error. This app expects a daemon reachable over the local network or via relay.";
  } else if (raw) {
    detail = "Unable to connect. Check the host/port and that the daemon is reachable.";
  } else {
    detail = "Unable to connect. Check the host/port and that the daemon is reachable.";
  }

  return { title, detail, raw };
}

export interface AddHostModalProps {
  visible: boolean;
  onClose: () => void;
  targetServerId?: string;
  onCancel?: () => void;
  onSaved?: (result: { profile: HostProfile; serverId: string; hostname: string | null; isNewHost: boolean }) => void;
}

export function AddHostModal({ visible, onClose, onCancel, onSaved, targetServerId }: AddHostModalProps) {
  const { theme } = useUnistyles();
  const { daemons, upsertDirectConnection } = useDaemonRegistry();
  const isMobile =
    UnistylesRuntime.breakpoint === "xs" || UnistylesRuntime.breakpoint === "sm";

  const InputComponent = useMemo(() => (isMobile ? BottomSheetTextInput : TextInput), [isMobile]);
  const hostInputRef = useRef<TextInput>(null);

  const [endpointRaw, setEndpointRaw] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  const handleClose = useCallback(() => {
    if (isSaving) return;
    setEndpointRaw("");
    setErrorMessage("");
    onClose();
  }, [isSaving, onClose]);

  const handleCancel = useCallback(() => {
    if (isSaving) return;
    setEndpointRaw("");
    setErrorMessage("");
    (onCancel ?? onClose)();
  }, [isSaving, onCancel, onClose]);

  const handleSave = useCallback(async () => {
    if (isSaving) return;

    const raw = endpointRaw.trim();
    if (!raw) {
      setErrorMessage("Host is required");
      return;
    }
    if (!isHostPortOnly(raw)) {
      setErrorMessage("Enter host:port only (no ws://, no /ws)");
      return;
    }

    let endpoint: string;
    try {
      endpoint = normalizeHostPort(raw);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid host:port";
      setErrorMessage(message);
      return;
    }

    try {
      setIsSaving(true);
      setErrorMessage("");

      const { serverId, hostname } = await probeDaemonEndpoint(endpoint);
      if (targetServerId && serverId !== targetServerId) {
        const message = `That endpoint belongs to ${serverId}, not ${targetServerId}.`;
        setErrorMessage(message);
        if (!isMobile) {
          Alert.alert("Wrong daemon", message);
        }
        return;
      }

      const isNewHost = !daemons.some((daemon) => daemon.serverId === serverId);
      const profile = await upsertDirectConnection({
        serverId,
        endpoint,
      });

      onSaved?.({ profile, serverId, hostname, isNewHost });
      handleClose();
    } catch (error) {
      const { title, detail, raw } = buildConnectionFailureCopy(endpoint, error);
      const combined =
        raw && detail && raw !== detail
          ? `${title}\n${detail}\nDetails: ${raw}`
          : detail
            ? `${title}\n${detail}`
            : title;
      setErrorMessage(combined);
      if (!isMobile) {
        // Desktop/web: also surface it as a dialog for quick visibility.
        Alert.alert("Connection failed", combined);
      }
    } finally {
      setIsSaving(false);
    }
  }, [daemons, endpointRaw, handleClose, isMobile, isSaving, onSaved, targetServerId, upsertDirectConnection]);

  return (
    <AdaptiveModalSheet title="Direct connection" visible={visible} onClose={handleClose} testID="add-host-modal">
      <Text style={styles.helper}>Connect to a daemon by entering host:port.</Text>

      <View style={styles.field}>
        <Text style={styles.label}>Host</Text>
        <InputComponent
          ref={hostInputRef as any}
          value={endpointRaw}
          onChangeText={setEndpointRaw}
          placeholder="host:6767"
          placeholderTextColor={theme.colors.foregroundMuted}
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          editable={!isSaving}
          returnKeyType="done"
          onSubmitEditing={() => void handleSave()}
        />
        {errorMessage ? <Text style={styles.error}>{errorMessage}</Text> : null}
      </View>

      <View style={styles.actions}>
        <Pressable style={styles.button} onPress={handleCancel} disabled={isSaving}>
          <Text style={styles.buttonText}>{onCancel ? "Back" : "Cancel"}</Text>
        </Pressable>
        <Pressable
          style={[styles.button, styles.primaryButton, isSaving ? { opacity: 0.7 } : null]}
          onPress={() => void handleSave()}
          disabled={isSaving}
        >
          <View style={styles.connectRow}>
            <Link2 size={16} color={theme.colors.palette.white} />
            <Text style={[styles.buttonText, styles.primaryButtonText]}>
              {isSaving ? "Connecting..." : "Connect & Save"}
            </Text>
          </View>
        </Pressable>
      </View>
    </AdaptiveModalSheet>
  );
}
