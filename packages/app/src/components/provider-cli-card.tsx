import * as Clipboard from "expo-clipboard";
import { CheckCircle2, Copy, ExternalLink as ExternalLinkIcon } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { ProviderCliStatus } from "@getpaseo/protocol/provider-cli/rpc-schemas";
import {
  AdaptiveModalSheet,
  AdaptiveTextInput,
  type SheetHeader,
} from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ScrollableCodeSurface } from "@/components/ui/scrollable-code-surface";
import { StatusBadge } from "@/components/ui/status-badge";
import { isWeb } from "@/constants/platform";
import { useToast } from "@/contexts/toast-context";
import type { ProviderCli } from "@/hooks/use-provider-cli";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
import { settingsStyles } from "@/styles/settings";
import type { Theme } from "@/styles/theme";
import { openExternalUrl } from "@/utils/open-external-url";

const ThemedSpinner = withUnistyles(LoadingSpinner);
const ThemedCheckCircle = withUnistyles(CheckCircle2);
const mutedColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const successColor = (theme: Theme) => ({ color: theme.colors.statusSuccess });

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ProviderCliCardProps {
  providerLabel: string;
  status: ProviderCliStatus;
  cli: ProviderCli;
}

/** Version and account rows at the top of the provider sheet. */
export function ProviderCliCard({ providerLabel, status, cli }: ProviderCliCardProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const [loginOpen, setLoginOpen] = useState(false);
  // Hides the previous sign-in result until the daemon acknowledges the new one.
  const [loginStarting, setLoginStarting] = useState(false);
  const { provider } = status;
  const isUpdating = status.update.status === "running";

  const handleUpdate = useCallback(() => {
    void cli.update(provider).catch((error) => toast.error(describeError(error)));
  }, [cli, provider, toast]);

  const startLogin = useCallback(() => {
    setLoginStarting(true);
    void cli
      .startLogin(provider)
      .catch((error) => toast.error(describeError(error)))
      .finally(() => setLoginStarting(false));
  }, [cli, provider, toast]);

  const handleOpenLogin = useCallback(() => {
    setLoginOpen(true);
    startLogin();
  }, [startLogin]);

  const handleCloseLogin = useCallback(() => {
    setLoginOpen(false);
    if (status.login?.status === "running") {
      void cli.cancelLogin(provider);
    }
  }, [cli, provider, status.login?.status]);

  if (!status.installed) return null;

  return (
    <View style={styles.section}>
      <View style={settingsStyles.card} testID={`provider-cli-card-${provider}`}>
        <View style={settingsStyles.row}>
          <View style={settingsStyles.rowContent}>
            <View style={styles.titleRow}>
              <Text style={settingsStyles.rowTitle}>{t("settings.providers.cli.version")}</Text>
              {status.updateAvailable && !isUpdating ? (
                <StatusBadge
                  label={t("settings.providers.cli.updateAvailable")}
                  variant="warning"
                  size="xs"
                />
              ) : null}
            </View>
            <Text style={settingsStyles.rowHint}>{renderVersionHint(status, t)}</Text>
            {status.update.status === "failed" && status.update.error ? (
              <Text style={settingsStyles.rowError} numberOfLines={4}>
                {status.update.error}
              </Text>
            ) : null}
          </View>
          {status.update.supported && (status.updateAvailable || isUpdating) ? (
            <Button
              variant="outline"
              onPress={handleUpdate}
              disabled={isUpdating}
              loading={isUpdating}
              testID={`provider-cli-update-${provider}`}
            >
              {isUpdating
                ? t("settings.providers.cli.updating")
                : t("settings.providers.cli.update")}
            </Button>
          ) : null}
        </View>
        {status.auth.supported ? (
          <View style={[settingsStyles.row, settingsStyles.rowBorder]}>
            <View style={settingsStyles.rowContent}>
              <Text style={settingsStyles.rowTitle}>{t("settings.providers.cli.account")}</Text>
              <Text style={settingsStyles.rowHint} numberOfLines={1}>
                {renderAccountHint(status, t)}
              </Text>
            </View>
            <Button
              variant="outline"
              onPress={handleOpenLogin}
              testID={`provider-cli-sign-in-${provider}`}
            >
              {status.auth.status === "signed_in"
                ? t("settings.providers.cli.switchAccount")
                : t("settings.providers.cli.signIn")}
            </Button>
          </View>
        ) : null}
      </View>
      <ProviderLoginSheet
        providerLabel={providerLabel}
        provider={provider}
        login={loginStarting ? null : status.login}
        cli={cli}
        visible={loginOpen}
        onRetry={startLogin}
        onClose={handleCloseLogin}
      />
    </View>
  );
}

type Translate = ReturnType<typeof useTranslation>["t"];

function renderVersionHint(status: ProviderCliStatus, t: Translate): string {
  if (status.managedExternally) return t("settings.providers.cli.managedExternally");
  const current = status.version ?? t("settings.providers.cli.unknownVersion");
  if (status.update.status === "running") return current;
  if (status.updateAvailable && status.latestVersion) {
    return `${current} · ${t("settings.providers.cli.latest", { version: status.latestVersion })}`;
  }
  if (status.latestVersion) return `${current} · ${t("settings.providers.cli.upToDate")}`;
  return current;
}

function renderAccountHint(status: ProviderCliStatus, t: Translate): string {
  switch (status.auth.status) {
    case "signed_in":
      return status.auth.account
        ? t("settings.providers.cli.signedInAs", { account: status.auth.account })
        : t("settings.providers.cli.signedIn");
    case "signed_out":
      return t("settings.providers.cli.signedOut");
    default:
      return t("settings.providers.cli.authUnknown");
  }
}

interface ProviderLoginSheetProps {
  providerLabel: string;
  provider: string;
  login: ProviderCliStatus["login"];
  cli: ProviderCli;
  visible: boolean;
  onRetry: () => void;
  onClose: () => void;
}

function ProviderLoginSheet({
  providerLabel,
  provider,
  login,
  cli,
  visible,
  onRetry,
  onClose,
}: ProviderLoginSheetProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [showOutput, setShowOutput] = useState(false);

  useEffect(() => {
    if (!visible) {
      setCode("");
      setShowOutput(false);
    }
  }, [visible]);

  // Claude prints "Paste code here if prompted"; device-code flows never ask for one.
  const asksForCode = login?.status === "running" && /paste/i.test(login.output);

  const handleOpenPage = useCallback(() => {
    if (!login?.url) return;
    void openExternalUrl(login.url).catch((error) => toast.error(describeError(error)));
  }, [login?.url, toast]);

  const handleCopyLink = useCallback(() => {
    if (!login?.url) return;
    void Clipboard.setStringAsync(login.url).then(() =>
      toast.copied(t("settings.providers.cli.login.linkLabel")),
    );
  }, [login?.url, t, toast]);

  const handleCopyCode = useCallback(() => {
    if (!login?.code) return;
    void Clipboard.setStringAsync(login.code).then(() =>
      toast.copied(t("settings.providers.cli.login.codeLabel")),
    );
  }, [login?.code, t, toast]);

  const trimmedCode = code.trim();
  const handleSubmitCode = useCallback(() => {
    if (!trimmedCode || submitting) return;
    setSubmitting(true);
    void cli
      .sendLoginInput(provider, trimmedCode)
      .then(() => setCode(""))
      .catch((error) => toast.error(describeError(error)))
      .finally(() => setSubmitting(false));
  }, [cli, provider, submitting, toast, trimmedCode]);

  const handleToggleOutput = useCallback(() => setShowOutput((current) => !current), []);

  const header = useMemo<SheetHeader>(
    () => ({ title: t("settings.providers.cli.login.title", { name: providerLabel }) }),
    [providerLabel, t],
  );

  const footer = useMemo(
    () => (
      <View style={styles.footer}>
        {login?.output ? (
          <Button variant="ghost" size="sm" onPress={handleToggleOutput}>
            {showOutput
              ? t("settings.providers.cli.login.hideOutput")
              : t("settings.providers.cli.login.showOutput")}
          </Button>
        ) : (
          <View />
        )}
        {login?.status === "failed" || login?.status === "canceled" ? (
          <Button variant="default" size="sm" onPress={onRetry}>
            {t("settings.providers.cli.login.tryAgain")}
          </Button>
        ) : (
          <Button
            variant={login?.status === "succeeded" ? "default" : "secondary"}
            size="sm"
            onPress={onClose}
          >
            {login?.status === "succeeded"
              ? t("settings.providers.cli.login.done")
              : t("common.actions.cancel")}
          </Button>
        )}
      </View>
    ),
    [handleToggleOutput, login?.output, login?.status, onClose, onRetry, showOutput, t],
  );

  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      footer={footer}
      desktopMaxWidth={480}
      snapPoints={LOGIN_SNAP_POINTS}
      testID="provider-login-sheet"
    >
      <View style={styles.loginBody}>
        {renderLoginState()}
        {showOutput && login?.output ? (
          <ScrollableCodeSurface maxHeight={220}>{login.output}</ScrollableCodeSurface>
        ) : null}
      </View>
    </AdaptiveModalSheet>
  );

  function renderLoginState() {
    if (!login || (login.status === "running" && !login.url && !login.code)) {
      return (
        <View style={styles.statusLine}>
          <ThemedSpinner size={14} uniProps={mutedColor} />
          <Text style={styles.mutedText}>{t("settings.providers.cli.login.starting")}</Text>
        </View>
      );
    }
    if (login.status === "succeeded") {
      return (
        <View style={styles.resultBlock}>
          <ThemedCheckCircle size={28} uniProps={successColor} />
          <Text style={styles.resultTitle}>{t("settings.providers.cli.login.succeeded")}</Text>
          <Text style={styles.mutedText}>
            {t("settings.providers.cli.login.succeededHint", { name: providerLabel })}
          </Text>
        </View>
      );
    }
    if (login.status === "failed" || login.status === "canceled") {
      return (
        <View style={styles.resultBlock}>
          <Text style={styles.resultTitle}>
            {login.status === "failed"
              ? t("settings.providers.cli.login.failed")
              : t("settings.providers.cli.login.canceled")}
          </Text>
          {login.error ? <Text style={settingsStyles.rowError}>{login.error}</Text> : null}
        </View>
      );
    }
    return (
      <>
        {login.url ? (
          <View style={styles.step}>
            <Text style={styles.stepLabel}>{t("settings.providers.cli.login.openStep")}</Text>
            <View style={styles.actionsRow}>
              <Button
                variant="default"
                size="sm"
                leftIcon={ExternalLinkIcon}
                onPress={handleOpenPage}
              >
                {t("settings.providers.cli.login.openPage")}
              </Button>
              <Button variant="ghost" size="sm" leftIcon={Copy} onPress={handleCopyLink}>
                {t("settings.providers.cli.login.copyLink")}
              </Button>
            </View>
          </View>
        ) : null}
        {login.code ? (
          <View style={styles.step}>
            <Text style={styles.stepLabel}>{t("settings.providers.cli.login.codeStep")}</Text>
            <View style={[settingsStyles.card, styles.codeCard]}>
              <Text style={styles.code} selectable dataSet={CODE_SURFACE_DATASET}>
                {login.code}
              </Text>
              <Button variant="ghost" size="sm" leftIcon={Copy} onPress={handleCopyCode}>
                {t("settings.providers.cli.login.copyCode")}
              </Button>
            </View>
          </View>
        ) : null}
        {asksForCode ? (
          <View style={styles.step}>
            <Text style={styles.stepLabel}>{t("settings.providers.cli.login.pasteStep")}</Text>
            <View style={styles.actionsRow}>
              <AdaptiveTextInput
                initialValue={code}
                resetKey={`provider-login-${visible}`}
                onChangeText={setCode}
                onSubmitEditing={handleSubmitCode}
                placeholder={t("settings.providers.cli.login.pastePlaceholder")}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="done"
                // @ts-expect-error - outlineStyle is web-only
                style={[styles.input, isWeb && { outlineStyle: "none" }]}
              />
              <Button
                variant="secondary"
                size="sm"
                onPress={handleSubmitCode}
                disabled={!trimmedCode || submitting}
                loading={submitting}
              >
                {t("settings.providers.cli.login.submit")}
              </Button>
            </View>
          </View>
        ) : null}
        <View style={styles.statusLine}>
          <ThemedSpinner size={14} uniProps={mutedColor} />
          <Text style={styles.mutedText}>{t("settings.providers.cli.login.waiting")}</Text>
        </View>
      </>
    );
  }
}

const LOGIN_SNAP_POINTS = ["60%", "90%"];

const styles = StyleSheet.create((theme) => ({
  section: {
    marginBottom: theme.spacing[4],
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  loginBody: {
    gap: theme.spacing[4],
  },
  step: {
    gap: theme.spacing[2],
  },
  stepLabel: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  actionsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  codeCard: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
  },
  code: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.lg,
    letterSpacing: 2,
  },
  input: {
    flex: 1,
    minWidth: 0,
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    color: theme.colors.foreground,
    borderWidth: 1,
    borderColor: theme.colors.border,
    fontSize: theme.fontSize.base,
  },
  statusLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  mutedText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  resultBlock: {
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[6],
  },
  resultTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  footer: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
}));
