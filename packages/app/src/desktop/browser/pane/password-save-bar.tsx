import { useCallback, useEffect, useState } from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  getDesktopHost,
  type DesktopBrowserSavePasswordRequestEvent,
  type DesktopSavePasswordAction,
} from "@/desktop/host";
import { useStableEvent } from "@/hooks/use-stable-event";

type SavePasswordRequest = DesktopBrowserSavePasswordRequestEvent;

function readSavePasswordRequest(payload: unknown): SavePasswordRequest | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const candidate = payload as Partial<SavePasswordRequest>;
  if (
    typeof candidate.browserId !== "string" ||
    typeof candidate.requestId !== "string" ||
    typeof candidate.origin !== "string" ||
    typeof candidate.username !== "string" ||
    typeof candidate.update !== "boolean"
  ) {
    return null;
  }
  return {
    browserId: candidate.browserId,
    requestId: candidate.requestId,
    origin: candidate.origin,
    username: candidate.username,
    update: candidate.update,
  };
}

function readOrigin(url: string | null): string | null {
  if (!url) {
    return null;
  }
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

async function respondToPasswordSave(input: {
  requestId: string;
  action: DesktopSavePasswordAction;
}): Promise<boolean> {
  const respond = getDesktopHost()?.browser?.respondToPasswordSave;
  if (!respond) {
    throw new Error("Electron browser password bridge is unavailable");
  }
  return await respond(input);
}

function dismissPasswordSave(requestId: string): void {
  void respondToPasswordSave({ requestId, action: "dismiss" }).catch(() => {});
}

export function BrowserPasswordSaveBar({
  browserId,
  url,
}: {
  browserId: string;
  url: string | null;
}) {
  const { t } = useTranslation();
  const [request, setRequest] = useState<SavePasswordRequest | null>(null);
  const answer = useMutation({
    mutationFn: async (action: DesktopSavePasswordAction) => {
      if (!request) {
        return;
      }
      const accepted = await respondToPasswordSave({ requestId: request.requestId, action });
      if (!accepted && action === "save") {
        throw new Error(t("workspace.browser.passwords.saveFailed"));
      }
    },
    onSuccess: () => setRequest(null),
  });
  const resetAnswer = answer.reset;
  const answerMutate = answer.mutate;
  const handleSave = useCallback(() => answerMutate("save"), [answerMutate]);
  const handleNever = useCallback(() => answerMutate("never"), [answerMutate]);
  const handleNotNow = useCallback(() => answerMutate("dismiss"), [answerMutate]);

  const handleRequest = useStableEvent((payload: unknown) => {
    const next = readSavePasswordRequest(payload);
    if (!next || next.browserId !== browserId) {
      return;
    }
    resetAnswer();
    setRequest(next);
  });

  useEffect(() => {
    const unsubscribe = getDesktopHost()?.events?.on?.(
      "browser-save-password-request",
      handleRequest,
    );
    if (typeof unsubscribe === "function") {
      return unsubscribe;
    }
    return () => {
      void unsubscribe?.then((dispose) => dispose());
    };
  }, [handleRequest]);

  // The login's own redirect stays on the origin; leaving it means the prompt is stale.
  const currentOrigin = readOrigin(url);
  const hasLeftOrigin =
    request !== null && currentOrigin !== null && currentOrigin !== request.origin;
  useEffect(() => {
    if (hasLeftOrigin && request) {
      dismissPasswordSave(request.requestId);
      resetAnswer();
      setRequest(null);
    }
  }, [hasLeftOrigin, request, resetAnswer]);

  if (!request || hasLeftOrigin) {
    return null;
  }

  let prompt: string;
  if (request.update) {
    prompt = t("workspace.browser.passwords.updatePrompt", { username: request.username });
  } else if (request.username) {
    prompt = t("workspace.browser.passwords.savePrompt", {
      username: request.username,
      origin: request.origin,
    });
  } else {
    prompt = t("workspace.browser.passwords.savePromptNoUsername", { origin: request.origin });
  }

  return (
    <View style={styles.bar} testID={`browser-password-save-bar-${browserId}`}>
      <View style={styles.message}>
        <Text numberOfLines={1} style={styles.prompt}>
          {prompt}
        </Text>
        {answer.error ? (
          <Text accessibilityRole="alert" numberOfLines={1} style={styles.error}>
            {answer.error.message}
          </Text>
        ) : null}
      </View>
      <View style={styles.actions}>
        <Button
          variant="outline"
          size="xs"
          loading={answer.isPending && answer.variables === "save"}
          disabled={answer.isPending}
          onPress={handleSave}
        >
          {t("workspace.browser.passwords.save")}
        </Button>
        <Button variant="ghost" size="xs" disabled={answer.isPending} onPress={handleNever}>
          {t("workspace.browser.passwords.never")}
        </Button>
        <Button variant="ghost" size="xs" disabled={answer.isPending} onPress={handleNotNow}>
          {t("workspace.browser.passwords.notNow")}
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  bar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
  },
  message: {
    flex: 1,
    minWidth: 0,
  },
  prompt: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  error: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
  },
  actions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 0,
  },
}));
