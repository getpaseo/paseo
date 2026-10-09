import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { QrCode, Link2, ClipboardPaste, Terminal } from "lucide-react-native";
import { AdaptiveModalSheet, type SheetHeader } from "./adaptive-modal-sheet";
import { isFdroidBuild } from "@/constants/build-profile";
import { isNative } from "@/constants/platform";
import { isElectronRuntime } from "@/desktop/host";
import type { Theme } from "@/styles/theme";

const ThemedQrCode = withUnistyles(QrCode);
const ThemedLink2 = withUnistyles(Link2);
const ThemedClipboardPaste = withUnistyles(ClipboardPaste);
const ThemedTerminal = withUnistyles(Terminal);
const foregroundIconMapping = (theme: Theme) => ({ color: theme.colors.foreground });

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
    fontWeight: theme.fontWeight.normal,
  },
  optionSubtext: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
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
  onRemoteSsh: () => void;
  onScanQr: () => void;
  onPasteLink: () => void;
}

export function AddHostMethodModal({
  visible,
  onClose,
  onDirectConnection,
  onRemoteSsh,
  onScanQr,
  onPasteLink,
}: AddHostMethodModalProps) {
  const { t } = useTranslation();
  const header = useMemo<SheetHeader>(() => ({ title: t("pairing.connectionMethods.title") }), [t]);

  const handleDirect = useCallback(() => {
    onDirectConnection();
  }, [onDirectConnection]);

  const handleScan = useCallback(() => {
    onScanQr();
  }, [onScanQr]);

  const handleRemoteSsh = useCallback(() => {
    onRemoteSsh();
  }, [onRemoteSsh]);

  const handlePaste = useCallback(() => {
    onPasteLink();
  }, [onPasteLink]);

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      testID="add-host-method-modal"
    >
      <Pressable
        style={styles.option}
        onPress={handleDirect}
        accessibilityRole="button"
        accessibilityLabel={t("pairing.connectionMethods.direct.title")}
        testID="add-host-method-direct"
      >
        <ThemedLink2 size={18} uniProps={foregroundIconMapping} />
        <View style={styles.optionBody}>
          <Text style={styles.optionText}>{t("pairing.connectionMethods.direct.title")}</Text>
          <Text style={styles.optionSubtext}>
            {t("pairing.connectionMethods.direct.description")}
          </Text>
        </View>
      </Pressable>

      {isElectronRuntime() ? (
        <Pressable
          style={styles.option}
          onPress={handleRemoteSsh}
          accessibilityRole="button"
          accessibilityLabel={t("pairing.connectionMethods.remoteSsh.title")}
          testID="add-host-method-remote-ssh"
        >
          <ThemedTerminal size={18} uniProps={foregroundIconMapping} />
          <View style={styles.optionBody}>
            <Text style={styles.optionText}>{t("pairing.connectionMethods.remoteSsh.title")}</Text>
            <Text style={styles.optionSubtext}>
              {t("pairing.connectionMethods.remoteSsh.description")}
            </Text>
          </View>
        </Pressable>
      ) : null}

      {isNative && !isFdroidBuild ? (
        <Pressable
          style={styles.option}
          onPress={handleScan}
          accessibilityRole="button"
          accessibilityLabel={t("pairing.connectionMethods.scanQr.title")}
        >
          <ThemedQrCode size={18} uniProps={foregroundIconMapping} />
          <View style={styles.optionBody}>
            <Text style={styles.optionText}>{t("pairing.connectionMethods.scanQr.title")}</Text>
            <Text style={styles.optionSubtext}>
              {t("pairing.connectionMethods.scanQr.description")}
            </Text>
          </View>
        </Pressable>
      ) : null}

      <Pressable
        style={styles.option}
        onPress={handlePaste}
        accessibilityRole="button"
        accessibilityLabel={t("pairing.connectionMethods.pasteLink.title")}
        testID="add-host-method-pair-link"
      >
        <ThemedClipboardPaste size={18} uniProps={foregroundIconMapping} />
        <View style={styles.optionBody}>
          <Text style={styles.optionText}>{t("pairing.connectionMethods.pasteLink.title")}</Text>
          <Text style={styles.optionSubtext}>
            {t("pairing.connectionMethods.pasteLink.description")}
          </Text>
        </View>
      </Pressable>
    </AdaptiveModalSheet>
  );
}
