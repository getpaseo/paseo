import { useCallback } from "react";
import { Pressable, Text, View, Platform } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { QrCode, Link2, ClipboardPaste } from "lucide-react-native";
import { AdaptiveModalSheet } from "./adaptive-modal-sheet";

const styles = StyleSheet.create((theme) => ({
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[4],
    padding: theme.spacing[4],
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  optionText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  optionSubtext: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginTop: theme.spacing[1],
  },
  optionBody: {
    flex: 1,
  },
}));

export interface AddHostMethodModalProps {
  visible: boolean;
  onClose: () => void;
  onDirectConnection: () => void;
  onScanQr: () => void;
  onPasteLink: () => void;
}

export function AddHostMethodModal({
  visible,
  onClose,
  onDirectConnection,
  onScanQr,
  onPasteLink,
}: AddHostMethodModalProps) {
  const { theme } = useUnistyles();

  const handleDirect = useCallback(() => {
    onDirectConnection();
  }, [onDirectConnection]);

  const handleScan = useCallback(() => {
    onScanQr();
  }, [onScanQr]);

  const handlePaste = useCallback(() => {
    onPasteLink();
  }, [onPasteLink]);

  return (
    <AdaptiveModalSheet title="Add connection" visible={visible} onClose={onClose} testID="add-host-method-modal">
      <Pressable style={styles.option} onPress={handleDirect} accessibilityLabel="Direct connection">
        <Link2 size={18} color={theme.colors.foreground} />
        <View style={styles.optionBody}>
          <Text style={styles.optionText}>Direct connection</Text>
          <Text style={styles.optionSubtext}>Local network or Tailscale (unencrypted).</Text>
        </View>
      </Pressable>

      {Platform.OS !== "web" ? (
        <Pressable style={styles.option} onPress={handleScan} accessibilityLabel="Scan QR code">
          <QrCode size={18} color={theme.colors.foreground} />
          <View style={styles.optionBody}>
            <Text style={styles.optionText}>Scan QR code</Text>
            <Text style={styles.optionSubtext}>Relay pairing (E2EE).</Text>
          </View>
        </Pressable>
      ) : null}

      <Pressable style={styles.option} onPress={handlePaste} accessibilityLabel="Paste pairing link">
        <ClipboardPaste size={18} color={theme.colors.foreground} />
        <View style={styles.optionBody}>
          <Text style={styles.optionText}>Paste pairing link</Text>
          <Text style={styles.optionSubtext}>Relay pairing (E2EE).</Text>
        </View>
      </Pressable>
    </AdaptiveModalSheet>
  );
}
