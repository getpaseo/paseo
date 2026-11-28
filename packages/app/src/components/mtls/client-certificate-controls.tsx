import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";

export interface ClientCertificateApi {
  selected(host: string, port: number): string | null;
  choose(host: string, port: number): Promise<string | null>;
  remove(host: string, port: number): Promise<void>;
}

export function ClientCertificateControls({
  host,
  port,
  disabled = false,
  certificates,
}: {
  host: string;
  port: number;
  disabled?: boolean;
  certificates: ClientCertificateApi;
}) {
  const { t } = useTranslation();
  const [alias, setAlias] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    try {
      setAlias(certificates.selected(host, port));
    } catch {
      setError(t("clientCertificate.failed"));
    }
  }, [certificates, host, port, t]);

  const change = useCallback(
    async (remove: boolean) => {
      setBusy(true);
      setError("");
      try {
        if (remove) {
          await certificates.remove(host, port);
          setAlias(null);
        } else {
          const selected = await certificates.choose(host, port);
          if (selected !== null) setAlias(selected);
        }
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : t("clientCertificate.failed"));
      } finally {
        setBusy(false);
      }
    },
    [certificates, host, port, t],
  );
  const handleChoose = useCallback(() => void change(false), [change]);
  const handleRemove = useCallback(() => void change(true), [change]);

  return (
    <View style={styles.field} testID="client-certificate-field">
      <Text style={styles.label}>{t("clientCertificate.title")}</Text>
      <Text style={styles.hint}>{alias ?? t("clientCertificate.none")}</Text>
      <Text style={styles.hint}>{t("clientCertificate.scope", { host, port })}</Text>
      <View style={styles.actions}>
        <Button
          variant="secondary"
          disabled={disabled || busy}
          onPress={handleChoose}
          testID="client-certificate-choose"
        >
          {busy ? t("common.loading") : t("clientCertificate.choose")}
        </Button>
        {alias !== null ? (
          <Button
            variant="ghost"
            disabled={disabled || busy}
            onPress={handleRemove}
            testID="client-certificate-remove"
          >
            {t("clientCertificate.remove")}
          </Button>
        ) : null}
      </View>
      {error ? (
        <Text style={styles.error} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  field: { gap: theme.spacing[2] },
  label: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
  actions: { flexDirection: "row", gap: theme.spacing[2] },
}));
