import { useCallback, useEffect, useMemo, useRef, type ReactElement } from "react";
import { Text, View } from "react-native";
import { CheckCircle2, Copy, ExternalLink } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type {
  ProviderAccountLogin,
  ProviderAccountProfile,
} from "@getpaseo/protocol/provider-accounts";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { copyToClipboard } from "@/utils/copy-to-clipboard";
import { openExternalUrl } from "@/utils/open-external-url";
import { providerAccountCopy as copy } from "./copy";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const spinnerColor = (theme: { colors: { foregroundMuted: string } }) => ({
  color: theme.colors.foregroundMuted,
});

function isWaiting(login: ProviderAccountLogin | null): boolean {
  return login === null || login.status === "starting" || login.status === "waiting";
}

function isTerminal(login: ProviderAccountLogin | null): boolean {
  return (
    login?.status === "succeeded" || login?.status === "failed" || login?.status === "canceled"
  );
}

function LoginWaiting({ login }: { login: ProviderAccountLogin | null }): ReactElement | null {
  if (!isWaiting(login)) return null;
  return (
    <View style={styles.centered}>
      <ThemedLoadingSpinner size="large" uniProps={spinnerColor} />
      <Text style={styles.title}>
        {login?.status === "waiting" ? copy.signInWaiting : copy.signInStarting}
      </Text>
      {login?.status === "waiting" && !login.verificationUrl ? (
        <Text style={styles.description}>{copy.signInOnHost}</Text>
      ) : null}
    </View>
  );
}

function LoginResult({ login }: { login: ProviderAccountLogin | null }): ReactElement | null {
  if (login?.status === "succeeded") {
    return (
      <View style={styles.centered}>
        <CheckCircle2 size={36} color={styles.successIcon.color} />
        <Text style={styles.title}>{copy.signInComplete}</Text>
        <Text style={styles.description}>{copy.signInCompleteHint}</Text>
      </View>
    );
  }
  if (login?.status === "failed") {
    return (
      <Alert variant="error" title={copy.signInFailed} description={login.error ?? undefined} />
    );
  }
  return null;
}

export function ProviderAccountLoginModal({
  account,
  login,
  onPoll,
  onCancel,
  onClose,
}: {
  account: ProviderAccountProfile | null;
  login: ProviderAccountLogin | null;
  onPoll: () => Promise<void>;
  onCancel: () => Promise<void>;
  onClose: () => void;
}): ReactElement | null {
  const pollInFlight = useRef(false);
  const polling = login?.status === "starting" || login?.status === "waiting";
  useEffect(() => {
    if (!account || !polling) return;
    const timer = setInterval(() => {
      if (pollInFlight.current) return;
      pollInFlight.current = true;
      void onPoll().finally(() => {
        pollInFlight.current = false;
      });
    }, 1_000);
    return () => clearInterval(timer);
  }, [account, onPoll, polling]);

  const header = useMemo<SheetHeader>(
    () => ({ title: copy.signInTitle(account?.name ?? "account") }),
    [account?.name],
  );
  const handleOpenBrowser = useCallback(() => {
    if (login?.verificationUrl) void openExternalUrl(login.verificationUrl);
  }, [login?.verificationUrl]);
  const handleCopyCode = useCallback(() => {
    if (login?.userCode) void copyToClipboard(login.userCode);
  }, [login?.userCode]);
  const handleCancel = useCallback(() => {
    void onCancel();
  }, [onCancel]);

  if (!account) return null;
  const waiting = isWaiting(login);
  const terminal = isTerminal(login);
  return (
    <AdaptiveModalSheet
      visible
      header={header}
      onClose={terminal ? onClose : handleCancel}
      desktopMaxWidth={480}
      testID="provider-account-login-modal"
    >
      <View style={styles.body}>
        <LoginWaiting login={login} />

        {login?.userCode ? (
          <View style={styles.codeCard}>
            <Text style={styles.codeLabel}>{copy.deviceCode}</Text>
            <Text selectable style={styles.code} testID="provider-account-login-code">
              {login.userCode}
            </Text>
            <Button variant="outline" size="sm" leftIcon={Copy} onPress={handleCopyCode}>
              {copy.copyCode}
            </Button>
          </View>
        ) : null}

        <LoginResult login={login} />

        <View style={styles.actions}>
          {login?.verificationUrl && waiting ? (
            <Button leftIcon={ExternalLink} onPress={handleOpenBrowser}>
              {copy.openBrowser}
            </Button>
          ) : null}
          {waiting ? (
            <Button variant="ghost" onPress={handleCancel}>
              {copy.cancelSignIn}
            </Button>
          ) : (
            <Button onPress={onClose}>{copy.close}</Button>
          )}
        </View>
      </View>
    </AdaptiveModalSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.spacing[4] },
  centered: { alignItems: "center", gap: theme.spacing[2], paddingVertical: theme.spacing[3] },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.semibold,
    textAlign: "center",
  },
  description: { color: theme.colors.foregroundMuted, textAlign: "center" },
  codeCard: {
    alignItems: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[4],
    borderRadius: theme.borderRadius.xl,
    backgroundColor: theme.colors.surface2,
  },
  codeLabel: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  code: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize["2xl"],
    fontWeight: theme.fontWeight.semibold,
    letterSpacing: 2,
  },
  successIcon: { color: theme.colors.statusSuccess },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
  },
}));
