import { useCallback, useMemo } from "react";
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

type PairingViewState =
  | { tag: "loading" }
  | { tag: "error"; message: string }
  | { tag: "unavailable"; message: string }
  | { tag: "ready"; url: string };

function resolvePairingViewState(args: {
  isPending: boolean;
  isError: boolean;
  error: unknown;
  data: { url?: string | null; relayEnabled?: boolean } | undefined;
}): PairingViewState {
  if (args.isPending) return { tag: "loading" };
  if (args.isError) {
    const message =
      args.error instanceof Error ? args.error.message : "Failed to load pairing offer.";
    return { tag: "error", message };
  }
  if (!args.data?.url) {
    const message =
      args.data?.relayEnabled === false
        ? "Relay is not enabled. Enable relay to pair a device."
        : "Pairing offer unavailable.";
    return { tag: "unavailable", message };
  }
  return { tag: "ready", url: args.data.url };
}

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

  const handleRefetch = useCallback(() => {
    void pairingQuery.refetch();
  }, [pairingQuery]);

  const handleCopyPress = useCallback(() => {
    void handleCopyLink();
  }, [handleCopyLink]);

  const qrImageSource = useMemo(
    () => (qrQuery.data ? { uri: qrQuery.data } : null),
    [qrQuery.data],
  );

  const retryIcon = useMemo(
    () => <RotateCw size={theme.iconSize.sm} color={theme.colors.foreground} />,
    [theme.iconSize.sm, theme.colors.foreground],
  );
  const copyButtonIcon = useMemo(
    () =>
      copied ? (
        <Check size={theme.iconSize.sm} color={theme.colors.accent} />
      ) : (
        <Copy size={theme.iconSize.sm} color={theme.colors.foreground} />
      ),
    [copied, theme.iconSize.sm, theme.colors.accent, theme.colors.foreground],
  );

  if (!showSection) return null;

  const viewState = resolvePairingViewState({
    isPending: pairingQuery.isPending,
    isError: pairingQuery.isError,
    error: pairingQuery.error,
    data: pairingQuery.data,
  });

  return (
    <View style={settingsStyles.section} testID="host-page-pair-device-card">
      <View style={settingsStyles.card}>
        <PairDeviceBody
          viewState={viewState}
          theme={theme}
          retryIcon={retryIcon}
          copyButtonIcon={copyButtonIcon}
          qrImageSource={qrImageSource}
          qrQuery={qrQuery}
          copied={copied}
          handleRefetch={handleRefetch}
          handleCopyPress={handleCopyPress}
        />
      </View>
    </View>
  );
}

interface PairDeviceBodyProps {
  viewState: PairingViewState;
  theme: { colors: { accent: string } };
  retryIcon: React.ReactElement;
  copyButtonIcon: React.ReactElement;
  qrImageSource: { uri: string } | null;
  qrQuery: { isError: boolean };
  copied: boolean;
  handleRefetch: () => void;
  handleCopyPress: () => void;
}

function PairDeviceBody(props: PairDeviceBodyProps) {
  const {
    viewState,
    theme,
    retryIcon,
    copyButtonIcon,
    qrImageSource,
    qrQuery,
    copied,
    handleRefetch,
    handleCopyPress,
  } = props;

  if (viewState.tag === "loading") {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="small" />
        <Text style={styles.hint}>Loading pairing offer…</Text>
      </View>
    );
  }

  if (viewState.tag === "error" || viewState.tag === "unavailable") {
    return (
      <View style={styles.centered}>
        <Text style={styles.hint}>{viewState.message}</Text>
        <Button variant="outline" size="sm" leftIcon={retryIcon} onPress={handleRefetch}>
          Retry
        </Button>
      </View>
    );
  }

  return (
    <View style={styles.content}>
      <Text style={styles.hint}>
        Scan this QR code with Paseo on your phone, or copy the link below.
      </Text>
      <View style={styles.qrContainer}>
        <PairDeviceQrContent qrImageSource={qrImageSource} qrQuery={qrQuery} />
      </View>
      <View style={styles.linkRow}>
        <View style={styles.inputWrapper}>
          <TextInput
            style={styles.linkInput}
            value={viewState.url}
            readOnly
            selectTextOnFocus
            selectionColor={theme.colors.accent}
          />
        </View>
        <Button variant="outline" size="sm" leftIcon={copyButtonIcon} onPress={handleCopyPress}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </View>
    </View>
  );
}

function PairDeviceQrContent(props: {
  qrImageSource: { uri: string } | null;
  qrQuery: { isError: boolean };
}) {
  if (props.qrImageSource) {
    return <Image source={props.qrImageSource} style={styles.qrImage} resizeMode="contain" />;
  }
  if (props.qrQuery.isError) {
    return <Text style={styles.hint}>QR code unavailable.</Text>;
  }
  return <ActivityIndicator size="small" />;
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
  } as object,
}));
