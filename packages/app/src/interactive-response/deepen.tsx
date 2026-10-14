import { useRef, useState, useCallback } from "react";
import { Text, View } from "react-native";
import type { SendMessageOptions } from "@getpaseo/client/internal/daemon-client";
import { Button } from "@/components/ui/button";
import { useInteractiveConversation } from "./context";
import type { StreamItem } from "@/types/stream";
import { useTranslation } from "react-i18next";
import { styles } from "./styles";
import { sendConversationAction } from "./send";
export function DeepenResponse({
  getContent,
  items,
  startIndex,
}: {
  getContent: () => string;
  items: StreamItem[];
  startIndex: number;
}) {
  const context = useInteractiveConversation();
  const { t } = useTranslation();
  const [status, setStatus] = useState<"idle" | "pending" | "sent" | "queued" | "error">("idle");
  const [error, setError] = useState("");
  const request = useRef<{
    id: string;
    text: string;
    deepenReference: SendMessageOptions["deepenReference"];
  } | null>(null);
  const pending = useRef(false);
  const send = useCallback(async () => {
    if (pending.current || !context?.client) return;
    if (!context.supported) {
      setError(t("interactive.updateHost"));
      return;
    }
    pending.current = true;
    setStatus("pending");
    setError("");
    try {
      const first = items[startIndex];
      if (first?.kind !== "assistant_message" || (!first.timelineCursor && !first.messageId))
        throw new Error(t("interactive.reloadConflict"));
      request.current ??= {
        id: crypto.randomUUID(),
        text: `${t("interactive.deepenPrompt")}\n\n« ${getContent().slice(0, 160)} »`,
        deepenReference: {
          ...(first.timelineCursor ? { cursor: first.timelineCursor } : {}),
          ...(first.messageId ? { messageId: first.messageId } : {}),
        },
      };
      setStatus(await sendConversationAction(context, request.current));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
      setStatus("error");
    } finally {
      pending.current = false;
    }
  }, [context, items, startIndex, getContent, t]);
  if (!context || !context.supported || context.readOnly) return null;
  const label =
    status === "sent" || status === "queued"
      ? (`interactive.${status}` as const)
      : "interactive.deepen";
  return (
    <View>
      <Button
        size="xs"
        variant="ghost"
        loading={status === "pending"}
        disabled={!context.client || status === "sent" || status === "queued"}
        onPress={send}
      >
        {t(label)}
      </Button>
      {error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}
