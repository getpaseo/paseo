import { useCallback, useMemo, useState } from "react";
import { Image, Text, TextInput, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import * as QRCode from "qrcode";
import { useMutation } from "@tanstack/react-query";
import { Check, Copy, Network, RotateCw, ShieldCheck } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ExternalLink } from "@/components/ui/external-link";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useFetchQuery } from "@/data/query";
import { daemonPairingOfferQueryKey } from "@/data/daemon-pairing";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import { useHostRuntimeClient, useHostRuntimeSnapshot } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";

const RELAY_DOCS_URL = "https://paseo.sh/docs/security";
const FLEX_ONE_STYLE = { flex: 1 } as const;
const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const ThemedShieldCheck = withUnistyles(ShieldCheck);
const ThemedNetwork = withUnistyles(Network);
const foregroundMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
});
const accentBrightColorMapping = (theme: Theme) => ({ color: theme.colors.accentBright });

export interface PairDeviceSectionProps {
  serverId: string;
  onClose: () => void;
}

export function PairDeviceSection({ serverId, onClose }: PairDeviceSectionProps) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const runtimeSnapshot = useHostRuntimeSnapshot(serverId);
  const isConnected = runtimeSnapshot?.connectionStatus === "online";
  const isDisconnected =
    runtimeSnapshot?.connectionStatus === "offline" ||
    runtimeSnapshot?.connectionStatus === "error";
  const { patchConfig } = useDaemonConfig(serverId);
  const [copied, setCopied] = useState(false);
  const serverFeatures = client?.getLastServerInfoMessage()?.features;
  const supportsPairingRpc = serverFeatures?.daemonStatusRpc === true;
  const canConfigureRelay = supportsPairingRpc && serverFeatures?.relayConfig === true;

  const pairingQuery = useFetchQuery({
    queryKey: daemonPairingOfferQueryKey(serverId),
    queryFn: async () => {
      if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
      return client.getDaemonPairingOffer();
    },
    enabled: supportsPairingRpc && Boolean(client && isConnected),
    dataShape: "value",
    staleTimeMs: 5 * 60 * 1000,
    retry: 1,
  });

  const enableRelay = useMutation({
    mutationFn: async () => {
      if (client?.getLastServerInfoMessage()?.features?.relayConfig !== true) {
        throw new Error(t("pairing.device.updateRequired"));
      }
      const config = await patchConfig({ relay: { enabled: true } });
      if (!config) throw new Error(t("workspace.terminal.hostDisconnected"));
      return pairingQuery.refetch();
    },
  });

  const qrQuery = useFetchQuery({
    queryKey: ["daemon-pairing-offer-qr", pairingQuery.data?.url],
    queryFn: () =>
      QRCode.toDataURL(pairingQuery.data?.url ?? "", {
        errorCorrectionLevel: "M",
        margin: 1,
        width: 480,
      }),
    enabled: Boolean(pairingQuery.data?.url),
    dataShape: "value",
    staleTimeMs: 5 * 60 * 1000,
  });

  const handleCopyLink = useCallback(async () => {
    if (!pairingQuery.data?.url) return;
    await Clipboard.setStringAsync(pairingQuery.data.url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [pairingQuery.data?.url]);
  const handleCopyPress = useCallback(() => {
    void handleCopyLink();
  }, [handleCopyLink]);
  const handleRetry = useCallback(() => {
    void pairingQuery.refetch();
  }, [pairingQuery]);
  const handleEnableRelay = useCallback(() => {
    enableRelay.mutate();
  }, [enableRelay]);

  const qrImageSource = useMemo(
    () => (qrQuery.data ? { uri: qrQuery.data } : null),
    [qrQuery.data],
  );

  return (
    <View testID="pair-device-content">
      <PairDeviceBody
        isPending={supportsPairingRpc && pairingQuery.isPending}
        isDisconnected={isDisconnected}
        error={pairingQuery.error}
        offer={pairingQuery.data}
        canConfigureRelay={canConfigureRelay}
        enablePending={enableRelay.isPending}
        enableError={enableRelay.error}
        qrImageSource={qrImageSource}
        qrError={qrQuery.isError}
        copied={copied}
        onRetry={handleRetry}
        onEnableRelay={handleEnableRelay}
        onClose={onClose}
        onCopy={handleCopyPress}
      />
    </View>
  );
}

interface PairDeviceBodyProps {
  isPending: boolean;
  isDisconnected: boolean;
  error: Error | null;
  offer: { relayEnabled: boolean; url: string } | undefined;
  canConfigureRelay: boolean;
  enablePending: boolean;
  enableError: Error | null;
  qrImageSource: { uri: string } | null;
  qrError: boolean;
  copied: boolean;
  onRetry: () => void;
  onEnableRelay: () => void;
  onClose: () => void;
  onCopy: () => void;
}

function PairDeviceBody(props: PairDeviceBodyProps) {
  const { t } = useTranslation();
  if (props.isDisconnected) {
    return (
      <OfferLoadError message={t("workspace.terminal.hostDisconnected")} onRetry={props.onRetry} />
    );
  }
  if (props.isPending) {
    return <Text style={styles.stateLine}>{t("pairing.device.loadingOffer")}</Text>;
  }
  if (props.error) {
    return <OfferLoadError message={props.error.message} onRetry={props.onRetry} />;
  }
  if (!props.offer?.relayEnabled) {
    return <RelayConsent {...props} />;
  }
  if (!props.offer.url) {
    return <Text style={styles.stateLine}>{t("pairing.device.unavailable")}</Text>;
  }
  return <PairingOffer {...props} offer={props.offer} />;
}

function OfferLoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <Alert variant="error" description={message}>
      <Button variant="outline" size="sm" leftIcon={RotateCw} onPress={onRetry}>
        {t("pairing.device.retry")}
      </Button>
    </Alert>
  );
}

function RelayConsent(props: PairDeviceBodyProps) {
  const { t } = useTranslation();
  let enableButtonLabel = t("pairing.device.enableRelay");
  if (props.enablePending) {
    enableButtonLabel = t("pairing.device.enablingRelay");
  } else if (props.enableError) {
    enableButtonLabel = t("pairing.device.retry");
  }
  return (
    <View style={styles.consent}>
      <View style={styles.hero}>
        <RelayHeroBadge />
        <Text style={styles.consentTitle}>{t("pairing.device.enableTitle")}</Text>
        <Text style={styles.consentDescription}>{t("pairing.device.enableDescription")}</Text>
        <ExternalLink
          href={RELAY_DOCS_URL}
          label={t("pairing.device.relayDocs")}
          accessibilityLabel={t("pairing.device.relayDocsAccessibility")}
        />
      </View>
      {props.enableError ? <Alert variant="error" description={props.enableError.message} /> : null}
      {!props.canConfigureRelay ? (
        <Alert variant="warning" description={t("pairing.device.updateRequired")} />
      ) : null}
      <View style={styles.actions}>
        <Button variant="secondary" style={FLEX_ONE_STYLE} onPress={props.onClose}>
          {t("pairing.device.notNow")}
        </Button>
        {props.canConfigureRelay ? (
          <Button
            variant="default"
            style={FLEX_ONE_STYLE}
            loading={props.enablePending}
            onPress={props.onEnableRelay}
          >
            {enableButtonLabel}
          </Button>
        ) : null}
      </View>
      <View style={styles.directRow}>
        <ThemedNetwork size={14} style={styles.directIcon} />
        <Text style={styles.directHint}>{t("pairing.device.directConnectionHint")}</Text>
      </View>
    </View>
  );
}

function RelayHeroBadge() {
  return (
    <View style={styles.heroBadge}>
      <ThemedShieldCheck size={20} uniProps={accentBrightColorMapping} />
    </View>
  );
}

function PairingOffer(props: PairDeviceBodyProps & { offer: { url: string } }) {
  const { t } = useTranslation();
  return (
    <View style={styles.offer}>
      <Text style={styles.offerHint}>{t("pairing.device.hint")}</Text>
      <View style={styles.qrTile}>
        <PairingQr imageSource={props.qrImageSource} isError={props.qrError} />
      </View>
      <View style={styles.linkRow}>
        <View style={styles.inputWrapper}>
          <TextInput
            style={styles.linkInput}
            value={props.offer.url}
            readOnly
            selectTextOnFocus
            accessibilityLabel={t("pairing.link.label")}
          />
        </View>
        <Button
          variant="outline"
          size="sm"
          leftIcon={props.copied ? Check : Copy}
          onPress={props.onCopy}
        >
          {props.copied ? t("pairing.device.copied") : t("pairing.device.copy")}
        </Button>
      </View>
    </View>
  );
}

function PairingQr({
  imageSource,
  isError,
}: {
  imageSource: { uri: string } | null;
  isError: boolean;
}) {
  const { t } = useTranslation();
  if (imageSource) {
    return (
      <Image
        source={imageSource}
        style={styles.qrImage}
        resizeMode="contain"
        accessibilityRole="image"
        accessibilityLabel={t("pairing.device.qrAccessibility")}
      />
    );
  }
  if (isError) {
    return <Text style={styles.hint}>{t("pairing.device.qrUnavailable")}</Text>;
  }
  return <ThemedLoadingSpinner size="small" uniProps={foregroundMutedColorMapping} />;
}

const styles = StyleSheet.create((theme) => ({
  stateLine: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
    paddingVertical: theme.spacing[6],
  },
  consent: {
    gap: theme.spacing[4],
  },
  hero: {
    alignItems: "flex-start",
    gap: theme.spacing[2],
  },
  heroBadge: {
    width: 48,
    height: 48,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: theme.spacing[1],
  },
  consentTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  consentDescription: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.5,
  },
  actions: {
    flexDirection: "row",
    gap: theme.spacing[3],
  },
  directRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingTop: theme.spacing[4],
  },
  directIcon: {
    color: theme.colors.foregroundMuted,
    marginTop: 1, // optical: seats the glyph on the hint's first text line
  },
  directHint: {
    flex: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    lineHeight: theme.fontSize.xs * 1.5,
  },
  offer: {
    gap: theme.spacing[4],
  },
  offerHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  qrTile: {
    alignSelf: "center",
    alignItems: "center",
    justifyContent: "center",
    width: 304,
    maxWidth: "100%",
    aspectRatio: 1,
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.xl,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.palette.white,
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
    borderRadius: theme.borderRadius.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface2,
    overflow: "hidden",
  },
  linkInput: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.xs,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    outlineStyle: "none",
  } as object,
  hint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
}));
