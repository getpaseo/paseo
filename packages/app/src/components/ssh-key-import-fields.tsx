import { Text } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { Field, FormTextInput } from "@/components/ui/form-field";
import { useIsCompactFormFactor } from "@/constants/layout";

interface SshKeyImportFieldsProps {
  keyName: string | null;
  fingerprint: string | null;
  disabled: boolean;
  onImport: () => void;
  onPassphraseChange: (value: string) => void;
}

/** Android's key file, passphrase, and explicit server-identity approval surface. */
export function SshKeyImportFields({
  keyName,
  fingerprint,
  disabled,
  onImport,
  onPassphraseChange,
}: SshKeyImportFieldsProps) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  return (
    <>
      <Field label={t("pairing.remoteSsh.keyImport.key")} testID="ssh-private-key">
        <Button variant="secondary" onPress={onImport} disabled={disabled} testID="ssh-import-key">
          {keyName ?? t("pairing.remoteSsh.keyImport.import")}
        </Button>
      </Field>
      <Field label={t("pairing.remoteSsh.keyImport.passphrase")}>
        <FormTextInput
          size={isCompact ? "md" : "sm"}
          initialValue=""
          onChangeText={onPassphraseChange}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          editable={!disabled}
          accessibilityLabel={t("pairing.remoteSsh.keyImport.passphrase")}
          testID="ssh-key-passphrase"
        />
      </Field>
      {fingerprint ? (
        <Field label={t("pairing.remoteSsh.keyImport.fingerprint")}>
          <Text selectable style={styles.fingerprint} testID="ssh-server-fingerprint">
            {fingerprint}
          </Text>
          <Text style={styles.instructions}>{t("pairing.remoteSsh.keyImport.verify")}</Text>
        </Field>
      ) : null}
    </>
  );
}
const styles = StyleSheet.create((theme) => ({
  fingerprint: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
  },
  instructions: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
}));
