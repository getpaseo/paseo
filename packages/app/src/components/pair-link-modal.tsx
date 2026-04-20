import { useCallback, useRef, useState } from "react";
import { Alert, Text, TextInput, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { Link } from "lucide-react-native";
import type { HostProfile } from "@/types/host-connection";
import { useHosts, useHostMutations } from "@/runtime/host-runtime";
import { decodeOfferFragmentPayload, normalizeHostPort } from "@/utils/daemon-endpoints";
import { connectToDaemon } from "@/utils/test-daemon-connection";
import { ConnectionOfferSchema } from "@server/shared/connection-offer";
import { AdaptiveModalSheet, AdaptiveTextInput } from "./adaptive-modal-sheet";
import { Button } from "@/components/ui/button";

const styles = StyleSheet.create((theme) => ({
  helper: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
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
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
  },
  actions: {
    flexDirection: "row",
    gap: theme.spacing[3],
    marginTop: theme.spacing[2],
  },
}));

export interface PairLinkModalProps {
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

export function PairLinkModal({ visible, onClose, onCancel, onSaved }: PairLinkModalProps) {
  const { theme } = useUnistyles();
  const daemons = useHosts();
  const { upsertConnectionFromOfferUrl: upsertDaemonFromOfferUrl } = useHostMutations();
  const isMobile = useIsCompactFormFactor();

  const offerUrlRef = useRef("");
  const inputRef = useRef<TextInput>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  const clearInput = useCallback(() => {
    offerUrlRef.current = "";
    inputRef.current?.clear();
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
    const raw = offerUrlRef.current.trim();
    if (!raw) {
      setErrorMessage("Paste a pairing link (…/#offer=...)");
      return;
    }
    if (!raw.includes("#offer=")) {
      setErrorMessage("Link must include #offer=...");
      return;
    }

    const parsedOffer = (() => {
      try {
        const idx = raw.indexOf("#offer=");
        const encoded = raw.slice(idx + "#offer=".length).trim();
        if (!encoded) {
          throw new Error("Offer payload is empty");
        }
        const payload = decodeOfferFragmentPayload(encoded);
        return ConnectionOfferSchema.parse(payload);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Invalid pairing link";
        setErrorMessage(message);
        if (!isMobile) {
          Alert.alert("Pairing failed", message);
        }
        return null;
      }
    })();

    if (!parsedOffer) {
      return;
    }

    try {
      setIsSaving(true);
      setErrorMessage("");

      const { client, hostname } = await connectToDaemon(
        {
          id: "probe",
          type: "relay",
          relayEndpoint: normalizeHostPort(parsedOffer.relay.endpoint),
          daemonPublicKeyB64: parsedOffer.daemonPublicKeyB64,
        },
        { serverId: parsedOffer.serverId },
      );
      await client.close().catch(() => undefined);

      const isNewHost = !daemons.some((daemon) => daemon.serverId === parsedOffer.serverId);
      const profile = await upsertDaemonFromOfferUrl(raw, hostname ?? undefined);
      onSaved?.({ profile, serverId: parsedOffer.serverId, hostname, isNewHost });
      handleClose();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to pair host";
      setErrorMessage(message);
      if (!isMobile) {
        Alert.alert("Pairing failed", message);
      }
    } finally {
      setIsSaving(false);
    }
  }, [daemons, handleClose, isMobile, isSaving, onSaved, upsertDaemonFromOfferUrl]);

  return (
    <AdaptiveModalSheet
      title="Paste pairing link"
      visible={visible}
      onClose={handleClose}
      testID="pair-link-modal"
    >
      <Text style={styles.helper}>Paste the pairing link from your server.</Text>

      <View style={styles.field}>
        <Text style={styles.label}>Pairing link</Text>
        <AdaptiveTextInput
          ref={inputRef}
          testID="pair-link-input"
          nativeID="pair-link-input"
          accessibilityLabel="pair-link-input"
          onChangeText={(next) => {
            offerUrlRef.current = next;
          }}
          placeholder="https://app.paseo.sh/#offer=..."
          placeholderTextColor={theme.colors.foregroundMuted}
          style={styles.input}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        {errorMessage ? <Text style={styles.error}>{errorMessage}</Text> : null}
      </View>

      <View style={styles.actions}>
        <Button
          style={{ flex: 1 }}
          variant="secondary"
          onPress={handleCancel}
          disabled={isSaving}
          testID="pair-link-cancel"
          accessibilityRole="button"
          accessibilityLabel="Cancel"
        >
          Cancel
        </Button>
        <Button
          style={{ flex: 1 }}
          variant="default"
          onPress={() => void handleSave()}
          disabled={isSaving}
          testID="pair-link-submit"
          accessibilityRole="button"
          accessibilityLabel="Pair"
          leftIcon={<Link size={16} color={theme.colors.palette.white} />}
        >
          {isSaving ? "Pairing..." : "Pair"}
        </Button>
      </View>
    </AdaptiveModalSheet>
  );
}
