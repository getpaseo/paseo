import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Pressable, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { CameraView, useCameraPermissions } from "expo-camera";
import type { BarcodeScanningResult } from "expo-camera";
import { useHostMutations } from "@/runtime/host-runtime";
import { decodeOfferFragmentPayload, normalizeHostPort } from "@/utils/daemon-endpoints";
import { connectToDaemon } from "@/utils/test-daemon-connection";
import { ConnectionOfferSchema } from "@server/shared/connection-offer";
import { buildHostRootRoute, buildSettingsHostRoute } from "@/utils/host-routes";
import { isWeb } from "@/constants/platform";
import { BackHeader } from "@/components/headers/back-header";

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  body: {
    flex: 1,
    paddingHorizontal: theme.spacing[6],
  },
  cameraWrap: {
    flex: 1,
    overflow: "hidden",
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface2,
  },
  camera: {
    flex: 1,
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    alignItems: "center",
  },
  scanFrame: {
    width: 260,
    height: 260,
  },
  corner: {
    position: "absolute",
    width: 36,
    height: 36,
    borderColor: theme.colors.accent,
  },
  cornerTL: {
    left: 0,
    top: 0,
    borderLeftWidth: 4,
    borderTopWidth: 4,
    borderTopLeftRadius: 12,
  },
  cornerTR: {
    right: 0,
    top: 0,
    borderRightWidth: 4,
    borderTopWidth: 4,
    borderTopRightRadius: 12,
  },
  cornerBL: {
    left: 0,
    bottom: 0,
    borderLeftWidth: 4,
    borderBottomWidth: 4,
    borderBottomLeftRadius: 12,
  },
  cornerBR: {
    right: 0,
    bottom: 0,
    borderRightWidth: 4,
    borderBottomWidth: 4,
    borderBottomRightRadius: 12,
  },
  helperText: {
    marginTop: theme.spacing[6],
    color: theme.colors.foregroundMuted,
    textAlign: "center",
    fontSize: theme.fontSize.base,
  },
  permissionCard: {
    marginTop: theme.spacing[6],
    padding: theme.spacing[6],
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface2,
    gap: theme.spacing[4],
  },
  permissionTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
  },
  permissionBody: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  permissionButton: {
    alignSelf: "flex-start",
    paddingHorizontal: theme.spacing[6],
    paddingVertical: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.palette.blue[500],
  },
  permissionButtonText: {
    color: theme.colors.palette.white,
    fontWeight: theme.fontWeight.semibold,
  },
}));

function extractOfferUrlFromScan(result: BarcodeScanningResult): string | null {
  const raw = typeof result.data === "string" ? result.data.trim() : "";
  if (!raw) return null;

  if (raw.includes("#offer=")) return raw;

  return null;
}

export default function PairScanScreen() {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const params = useLocalSearchParams<{
    source?: string;
  }>();
  const source = typeof params.source === "string" ? params.source : "settings";
  const { upsertConnectionFromOfferUrl: upsertDaemonFromOfferUrl } = useHostMutations();

  const [permission, requestPermission] = useCameraPermissions();
  const [isPairing, setIsPairing] = useState(false);
  const lastScannedRef = useRef<string | null>(null);

  const navigateToPairedHost = useCallback(
    (serverId: string) => {
      if (source === "onboarding") {
        router.replace(buildHostRootRoute(serverId));
        return;
      }
      router.replace(buildSettingsHostRoute(serverId));
    },
    [router, source],
  );

  const closeToSource = useCallback(() => {
    try {
      router.back();
    } catch {
      router.replace("/" as any);
    }
  }, [router]);

  useEffect(() => {
    if (isWeb) return;
    if (permission && permission.granted) return;
    void requestPermission().catch(() => undefined);
  }, [permission, requestPermission]);

  const handleScan = useCallback(
    async (result: BarcodeScanningResult) => {
      if (isPairing) return;
      const offerUrl = extractOfferUrlFromScan(result);
      if (!offerUrl) return;

      if (lastScannedRef.current === offerUrl) return;
      lastScannedRef.current = offerUrl;

      try {
        setIsPairing(true);
        const idx = offerUrl.indexOf("#offer=");
        const encoded = offerUrl.slice(idx + "#offer=".length).trim();
        const offerPayload = decodeOfferFragmentPayload(encoded);
        const offer = ConnectionOfferSchema.parse(offerPayload);

        const { client, hostname } = await connectToDaemon(
          {
            id: "probe",
            type: "relay",
            relayEndpoint: normalizeHostPort(offer.relay.endpoint),
            daemonPublicKeyB64: offer.daemonPublicKeyB64,
          },
          { serverId: offer.serverId },
        );
        await client.close().catch(() => undefined);

        const profile = await upsertDaemonFromOfferUrl(offerUrl, hostname ?? undefined);

        navigateToPairedHost(profile.serverId);
      } catch (error) {
        lastScannedRef.current = null;
        const message = error instanceof Error ? error.message : "Unable to pair host";
        Alert.alert("Error", message);
      } finally {
        setIsPairing(false);
      }
    },
    [isPairing, navigateToPairedHost, upsertDaemonFromOfferUrl],
  );

  if (isWeb) {
    return (
      <View style={styles.container}>
        <BackHeader title="Scan QR" onBack={() => router.back()} />
        <View style={[styles.body, { paddingBottom: insets.bottom + theme.spacing[6] }]}>
          <View style={styles.permissionCard}>
            <Text style={styles.permissionTitle}>Not available on web</Text>
            <Text style={styles.permissionBody}>
              QR scanning isn't supported in the web build. Use "Paste link" instead.
            </Text>
            <Pressable style={styles.permissionButton} onPress={closeToSource}>
              <Text style={styles.permissionButtonText}>Back to Settings</Text>
            </Pressable>
          </View>
        </View>
      </View>
    );
  }

  const granted = Boolean(permission?.granted);

  return (
    <View style={styles.container}>
      <BackHeader title="Scan QR" onBack={closeToSource} />

      <View style={[styles.body, { paddingBottom: insets.bottom + theme.spacing[6] }]}>
        {!granted ? (
          <View style={styles.permissionCard}>
            <Text style={styles.permissionTitle}>Camera permission</Text>
            <Text style={styles.permissionBody}>
              Allow camera access to scan the pairing QR code from your daemon.
            </Text>
            <Pressable style={styles.permissionButton} onPress={() => void requestPermission()}>
              <Text style={styles.permissionButtonText}>Grant permission</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.cameraWrap}>
            <CameraView
              style={styles.camera}
              facing="back"
              barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
              onBarcodeScanned={handleScan}
            />
            <View style={styles.overlay} pointerEvents="none">
              <View style={styles.scanFrame}>
                <View style={[styles.corner, styles.cornerTL]} />
                <View style={[styles.corner, styles.cornerTR]} />
                <View style={[styles.corner, styles.cornerBL]} />
                <View style={[styles.corner, styles.cornerBR]} />
              </View>
              {isPairing ? (
                <Text style={[styles.helperText, { color: theme.colors.foreground }]}>
                  Pairing…
                </Text>
              ) : null}
            </View>
          </View>
        )}
      </View>
    </View>
  );
}
