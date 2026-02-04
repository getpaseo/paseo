import { useCallback, useMemo, useState } from "react";
import { Alert, Pressable, Text, TextInput, View } from "react-native";
import { StyleSheet, UnistylesRuntime, useUnistyles } from "react-native-unistyles";
import { BottomSheetTextInput } from "@gorhom/bottom-sheet";
import { Link } from "lucide-react-native";
import { useDaemonRegistry, type HostProfile } from "@/contexts/daemon-registry-context";
import { AdaptiveModalSheet } from "./adaptive-modal-sheet";

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
  connectRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
  },
}));

export interface PairLinkModalProps {
  visible: boolean;
  onClose: () => void;
  onSaved?: (profile: HostProfile) => void;
}

export function PairLinkModal({ visible, onClose, onSaved }: PairLinkModalProps) {
  const { theme } = useUnistyles();
  const { upsertDaemonFromOfferUrl } = useDaemonRegistry();
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

    try {
      setIsSaving(true);
      setErrorMessage("");
      const profile = await upsertDaemonFromOfferUrl(raw);
      onSaved?.(profile);
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
  }, [handleClose, isMobile, isSaving, offerUrl, onSaved, upsertDaemonFromOfferUrl]);

  return (
    <AdaptiveModalSheet title="Paste pairing link" visible={visible} onClose={handleClose} testID="pair-link-modal">
      <Text style={styles.helper}>Paste the daemon’s pairing link.</Text>

      <View style={styles.field}>
        <Text style={styles.label}>Pairing link</Text>
        <InputComponent
          testID="pair-link-input"
          value={offerUrl}
          onChangeText={setOfferUrl}
          placeholder="https://app.paseo.sh/#offer=..."
          placeholderTextColor={theme.colors.foregroundMuted}
          style={styles.input}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
        />
        {errorMessage ? <Text style={styles.error}>{errorMessage}</Text> : null}
      </View>

      <View style={styles.actions}>
        <Pressable style={styles.button} onPress={handleClose} disabled={isSaving} testID="pair-link-cancel">
          <Text style={styles.buttonText}>Cancel</Text>
        </Pressable>
        <Pressable
          style={[styles.button, styles.primaryButton, isSaving ? { opacity: 0.7 } : null]}
          onPress={() => void handleSave()}
          disabled={isSaving}
          testID="pair-link-submit"
        >
          <View style={styles.connectRow}>
            <Link size={16} color={theme.colors.palette.white} />
            <Text style={[styles.buttonText, styles.primaryButtonText]}>
              {isSaving ? "Pairing..." : "Pair"}
            </Text>
          </View>
        </Pressable>
      </View>
    </AdaptiveModalSheet>
  );
}
