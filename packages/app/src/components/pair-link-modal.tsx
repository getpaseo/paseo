import { useCallback, useMemo, useState } from "react";
import { Alert, Text, TextInput, View } from "react-native";
import { StyleSheet, UnistylesRuntime, useUnistyles } from "react-native-unistyles";
import { BottomSheetTextInput } from "@gorhom/bottom-sheet";
import { Link } from "lucide-react-native";
import { useDaemonRegistry, type HostProfile } from "@/contexts/daemon-registry-context";
import { decodeOfferFragmentPayload } from "@/utils/daemon-endpoints";
import { ConnectionOfferSchema } from "@server/shared/connection-offer";
import { AdaptiveModalSheet } from "./adaptive-modal-sheet";
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
  targetServerId?: string;
  onCancel?: () => void;
  onSaved?: (result: { profile: HostProfile; serverId: string; hostname: string | null; isNewHost: boolean }) => void;
}

export function PairLinkModal({ visible, onClose, onCancel, onSaved, targetServerId }: PairLinkModalProps) {
  const { theme } = useUnistyles();
  const { daemons, upsertDaemonFromOfferUrl } = useDaemonRegistry();
  const isMobile =
    UnistylesRuntime.breakpoint === "xs" || UnistylesRuntime.breakpoint === "sm";
  const InputComponent = useMemo(() => (isMobile ? BottomSheetTextInput : TextInput), [isMobile]);

  const [offerUrl, setOfferUrl] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

  const handleClose = useCallback(() => {
    if (isSaving) return;
    setOfferUrl("");
    setErrorMessage("");
    onClose();
  }, [isSaving, onClose]);

  const handleCancel = useCallback(() => {
    if (isSaving) return;
    setOfferUrl("");
    setErrorMessage("");
    (onCancel ?? onClose)();
  }, [isSaving, onCancel, onClose]);

  const handleSave = useCallback(async () => {
    if (isSaving) return;
    const raw = offerUrl.trim();
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

    if (targetServerId && parsedOffer.serverId !== targetServerId) {
      const message = `That pairing link belongs to ${parsedOffer.serverId}, not ${targetServerId}.`;
      setErrorMessage(message);
      if (!isMobile) {
        Alert.alert("Wrong daemon", message);
      }
      return;
    }

    try {
      setIsSaving(true);
      setErrorMessage("");
      const isNewHost = !daemons.some((daemon) => daemon.serverId === parsedOffer.serverId);
      const profile = await upsertDaemonFromOfferUrl(raw);
      onSaved?.({ profile, serverId: parsedOffer.serverId, hostname: null, isNewHost });
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
  }, [daemons, handleClose, isMobile, isSaving, offerUrl, onSaved, targetServerId, upsertDaemonFromOfferUrl]);

  return (
    <AdaptiveModalSheet title="Paste pairing link" visible={visible} onClose={handleClose} testID="pair-link-modal">
      <Text style={styles.helper}>Paste the daemon’s pairing link.</Text>

      <View style={styles.field}>
        <Text style={styles.label}>Pairing link</Text>
        <InputComponent
          testID="pair-link-input"
          nativeID="pair-link-input"
          accessibilityLabel="pair-link-input"
          value={offerUrl}
          onChangeText={setOfferUrl}
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
