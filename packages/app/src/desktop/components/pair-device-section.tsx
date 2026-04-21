import { useCallback } from "react";
import { ActivityIndicator, Image, Text, TextInput, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as QRCode from "qrcode";
import { useQuery } from "@tanstack/react-query";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { RotateCw, Copy, Check } from "lucide-react-native";
import { settingsStyles } from "@/styles/settings";
import { Button } from "@/components/ui/button";
import { getDesktopDaemonPairing, shouldUseDesktopDaemon } from "@/desktop/daemon/desktop-daemon";
import { useState } from "react";

export function PairDeviceSection() {
  const { theme } = useUnistyles();
  const showSection = shouldUseDesktopDaemon();
  const [copied, setCopied] = useState(false);

  const pairingQuery = useQuery({
    queryKey: ["desktop-daemon-pairing"],
    queryFn: getDesktopDaemonPairing,
    enabled: showSection,
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });

  const qrQuery = useQuery({
    queryKey: ["desktop-daemon-pairing-qr", pairingQuery.data?.url],
    queryFn: () =>
      QRCode.toDataURL(pairingQuery.data!.url!, {
        errorCorrectionLevel: "M",
        margin: 1,
        width: 480,
      }),
    enabled: !!pairingQuery.data?.url,
    staleTime: Infinity,
  });

  const handleCopyLink = useCallback(async () => {
    if (!pairingQuery.data?.url) return;
    await Clipboard.setStringAsync(pairingQuery.data.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [pairingQuery.data?.url]);

  if (!showSection) return null;

  return (
    <View style={settingsStyles.section} testID="host-page-pair-device-card">
      <View style={settingsStyles.card}>
        {pairingQuery.isPending ? (
          <View style={styles.centered}>
            <ActivityIndicator size="small" />
            <Text style={styles.hint}>Loading pairing offer…</Text>
          </View>
        ) : pairingQuery.isError ? (
          <View style={styles.centered}>
            <Text style={styles.hint}>
              {pairingQuery.error instanceof Error
                ? pairingQuery.error.message
                : "Failed to load pairing offer."}
            </Text>
            <Button
              variant="outline"
              size="sm"
              leftIcon={<RotateCw size={theme.iconSize.sm} color={theme.colors.foreground} />}
              onPress={() => void pairingQuery.refetch()}
            >
              Retry
            </Button>
          </View>
        ) : !pairingQuery.data?.url ? (
          <View style={styles.centered}>
            <Text style={styles.hint}>
              {pairingQuery.data?.relayEnabled === false
                ? "Relay is not enabled. Enable relay to pair a device."
                : "Pairing offer unavailable."}
            </Text>
            <Button
              variant="outline"
              size="sm"
              leftIcon={<RotateCw size={theme.iconSize.sm} color={theme.colors.foreground} />}
              onPress={() => void pairingQuery.refetch()}
            >
              Retry
            </Button>
          </View>
        ) : (
          <View style={styles.content}>
            <Text style={styles.hint}>
              Scan this QR code with Paseo on your phone, or copy the link below.
            </Text>
            <View style={styles.qrContainer}>
              {qrQuery.data ? (
                <Image source={{ uri: qrQuery.data }} style={styles.qrImage} resizeMode="contain" />
              ) : qrQuery.isError ? (
                <Text style={styles.hint}>QR code unavailable.</Text>
              ) : (
                <ActivityIndicator size="small" />
              )}
            </View>
            <View style={styles.linkRow}>
              <View style={styles.inputWrapper}>
                <TextInput
                  style={styles.linkInput}
                  value={pairingQuery.data.url}
                  readOnly
                  selectTextOnFocus
                  selectionColor={theme.colors.accent}
                />
              </View>
              <Button
                variant="outline"
                size="sm"
                leftIcon={
                  copied ? (
                    <Check size={theme.iconSize.sm} color={theme.colors.accent} />
                  ) : (
                    <Copy size={theme.iconSize.sm} color={theme.colors.foreground} />
                  )
                }
                onPress={() => void handleCopyLink()}
              >
                {copied ? "Copied" : "Copy"}
              </Button>
            </View>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  centered: {
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    paddingVertical: theme.spacing[6],
    paddingHorizontal: theme.spacing[4],
  },
  content: {
    gap: theme.spacing[3],
    padding: theme.spacing[4],
  },
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    textAlign: "center",
  },
  qrContainer: {
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
    width: 320,
    height: 320,
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    padding: theme.spacing[2],
  },
  qrImage: {
    width: "100%",
    height: "100%",
  },
  linkRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  inputWrapper: {
    flex: 1,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    overflow: "hidden",
  },
  linkInput: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    outlineStyle: "none",
  } as any,
}));
