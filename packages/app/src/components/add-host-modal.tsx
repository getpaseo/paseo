import { useCallback, useRef, useState } from "react";
import { Alert, Text, TextInput, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { Link2 } from "lucide-react-native";
import type { HostProfile } from "@/types/host-connection";
import { useHosts, useHostMutations } from "@/runtime/host-runtime";
import { normalizeHostPort } from "@/utils/daemon-endpoints";
import { DaemonConnectionTestError, connectToDaemon } from "@/utils/test-daemon-connection";
import { AdaptiveModalSheet, AdaptiveTextInput } from "./adaptive-modal-sheet";
import { Button } from "@/components/ui/button";

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
  helper: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
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
        .filter((value) => value.length > 0),
    ),
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

function buildConnectionFailureCopy(
  endpoint: string,
  error: unknown,
): { title: string; detail: string | null; raw: string | null } {
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
    detail = "Connection refused. Is the server running at this address?";
  } else if (rawLower.includes("enotfound") || rawLower.includes("not found")) {
    detail = "Host not found. Check the hostname and try again.";
  } else if (rawLower.includes("ehostunreach") || rawLower.includes("host is unreachable")) {
    detail = "Host is unreachable. Check your network and firewall.";
  } else if (
    rawLower.includes("certificate") ||
    rawLower.includes("tls") ||
    rawLower.includes("ssl")
  ) {
    detail =
      "TLS error. Direct connections use an unencrypted local connection. Use relay for remote access.";
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
  onCancel?: () => void;
  onSaved?: (result: {
    profile: HostProfile;
    serverId: string;
    hostname: string | null;
    isNewHost: boolean;
  }) => void;
}

export function AddHostModal({ visible, onClose, onCancel, onSaved }: AddHostModalProps) {
  const { theme } = useUnistyles();
  const daemons = useHosts();
  const { upsertDirectConnection } = useHostMutations();
  const isMobile = useIsCompactFormFactor();

  const hostInputRef = useRef<TextInput>(null);
  const endpointRawRef = useRef("");

  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  const clearInput = useCallback(() => {
    endpointRawRef.current = "";
    hostInputRef.current?.clear();
  }, []);

  const handleClose = useCallback(() => {
    if (isSaving) return;
    clearInput();
    setErrorMessage("");
    onClose();
  }, [isSaving, clearInput, onClose]);

  const handleCancel = useCallback(() => {
    if (isSaving) return;
    clearInput();
    setErrorMessage("");
    (onCancel ?? onClose)();
  }, [isSaving, clearInput, onCancel, onClose]);

  const handleSave = useCallback(async () => {
    if (isSaving) return;

    const raw = endpointRawRef.current.trim();
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

      const { client, serverId, hostname } = await connectToDaemon({
        id: "probe",
        type: "directTcp",
        endpoint,
      });
      await client.close().catch(() => undefined);
      const isNewHost = !daemons.some((daemon) => daemon.serverId === serverId);
      const profile = await upsertDirectConnection({
        serverId,
        endpoint,
        label: hostname ?? undefined,
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
  }, [daemons, handleClose, isMobile, isSaving, onSaved, upsertDirectConnection]);

  return (
    <AdaptiveModalSheet
      title="Direct connection"
      visible={visible}
      onClose={handleClose}
      testID="add-host-modal"
    >
      <Text style={styles.helper}>Enter the address of a Paseo server.</Text>

      <View style={styles.field}>
        <Text style={styles.label}>Host</Text>
        <AdaptiveTextInput
          ref={hostInputRef}
          testID="direct-host-input"
          nativeID="direct-host-input"
          accessibilityLabel="direct-host-input"
          onChangeText={(next) => {
            endpointRawRef.current = next;
          }}
          placeholder="hostname:port"
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
        <Button style={{ flex: 1 }} variant="secondary" onPress={handleCancel} disabled={isSaving}>
          Cancel
        </Button>
        <Button
          style={{ flex: 1 }}
          variant="default"
          onPress={() => void handleSave()}
          disabled={isSaving}
          leftIcon={<Link2 size={16} color={theme.colors.palette.white} />}
          testID="direct-host-submit"
        >
          {isSaving ? "Connecting..." : "Connect"}
        </Button>
      </View>
    </AdaptiveModalSheet>
  );
}
