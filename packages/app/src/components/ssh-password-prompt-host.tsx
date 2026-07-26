import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { KeyRound } from "lucide-react-native";
import { AdaptiveModalSheet, AdaptiveTextInput, type SheetHeader } from "./adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { getDesktopHost, type SshPasswordRequestEvent } from "@/desktop/host";

const styles = StyleSheet.create((theme) => ({
  prompt: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginBottom: theme.spacing[3],
  },
  label: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    marginBottom: 4,
  },
  input: {
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.lg,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
  },
  buttonRow: {
    flexDirection: "row",
    gap: theme.spacing[2],
    marginTop: theme.spacing[4],
  },
}));

/**
 * Append unless already queued. The main process sends one event per prompt,
 * but a duplicate delivery must not make the user answer the same one twice.
 */
function enqueueRequest(
  pending: SshPasswordRequestEvent[],
  incoming: SshPasswordRequestEvent,
): SshPasswordRequestEvent[] {
  const alreadyQueued = pending.some((entry) => entry.requestId === incoming.requestId);
  return alreadyQueued ? pending : [...pending, incoming];
}

function isPasswordRequest(payload: unknown): payload is SshPasswordRequestEvent {
  if (!payload || typeof payload !== "object") return false;
  const event = payload as Partial<SshPasswordRequestEvent>;
  return typeof event.requestId === "string" && typeof event.prompt === "string";
}

/**
 * Renders SSH's password and key-passphrase prompts in Paseo's own UI.
 *
 * SSH will only take a secret from a program's stdout, so the desktop main
 * process runs a relay askpass that forwards the prompt here and waits for the
 * answer. That replaces shelling out to `zenity`/`kdialog`/`osascript`, which
 * meant an unstyled, unlocalized dialog we could not control.
 *
 * Mounted globally rather than inside the Add SSH Host modal: SSH can ask for
 * a secret on any later reconnect too, when no modal is open.
 */
export function SshPasswordPromptHost() {
  const { t } = useTranslation();
  // A queue, not a single slot: several hosts can reconnect at once (startup
  // fans out over every host), and each waiting ssh process is blocked until
  // its own prompt is answered. Dropping one would strand it until the
  // channel's timeout.
  const [queue, setQueue] = useState<SshPasswordRequestEvent[]>([]);
  const [secret, setSecret] = useState("");
  const request = queue[0] ?? null;

  useEffect(() => {
    const events = getDesktopHost()?.events;
    if (!events?.on) return;
    let unsubscribe: (() => void) | null = null;
    let disposed = false;

    void Promise.resolve(
      events.on("ssh-password-request", (payload) => {
        if (!isPasswordRequest(payload)) return;
        setQueue((pending) => enqueueRequest(pending, payload));
      }),
    ).then((off) => {
      if (disposed) off();
      else unsubscribe = off;
      return undefined;
    });

    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, []);

  const answer = useCallback(
    (value: string | null) => {
      if (!request) return;
      setQueue((pending) => pending.filter((entry) => entry.requestId !== request.requestId));
      setSecret("");
      // Answering is what unblocks ssh; declining aborts that attempt in the
      // main process, so there is nothing further to clean up here.
      void getDesktopHost()
        ?.ssh?.submitPassword({ requestId: request.requestId, secret: value })
        .catch(() => undefined);
    },
    [request],
  );

  const handleSubmit = useCallback(() => answer(secret), [answer, secret]);
  const handleCancel = useCallback(() => answer(null), [answer]);

  const kind = request?.kind ?? "password";
  const header = useMemo<SheetHeader>(
    () => ({
      title:
        kind === "passphrase"
          ? t("pairing.ssh.prompt.passphrase")
          : t("pairing.ssh.prompt.password"),
    }),
    [kind, t],
  );
  const icon = useMemo(() => <KeyRound size={16} />, []);

  if (!request) return null;

  return (
    <AdaptiveModalSheet header={header} visible onClose={handleCancel} testID="ssh-password-prompt">
      {/* SSH's own prompt: it carries the key path or user@host, and the user
          may have several of either in play. */}
      <Text style={styles.prompt}>{request.prompt}</Text>

      <Text style={styles.label}>{t("pairing.ssh.prompt.secret")}</Text>
      <AdaptiveTextInput
        testID="ssh-password-input"
        accessibilityLabel={t("pairing.ssh.prompt.secret")}
        value={secret}
        onChangeText={setSecret}
        style={styles.input}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        autoFocus
        onSubmitEditing={handleSubmit}
        returnKeyType="go"
      />

      <View style={styles.buttonRow}>
        <Button variant="ghost" onPress={handleCancel} testID="ssh-password-cancel">
          {t("pairing.ssh.prompt.cancel")}
        </Button>
        <Button
          variant="default"
          onPress={handleSubmit}
          leftIcon={icon}
          testID="ssh-password-submit"
        >
          {t("pairing.ssh.prompt.submit")}
        </Button>
      </View>
    </AdaptiveModalSheet>
  );
}
