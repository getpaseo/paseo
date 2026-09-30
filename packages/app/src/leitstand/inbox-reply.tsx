import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { EditingTextInput, type EditingTextInputHandle } from "@/components/ui/text-input";
import { useFetchQuery } from "@/data/query";
import { useHostFeature } from "@/runtime/host-features";
import { useHostRuntimeClient } from "@/runtime/host-runtime";

const PREVIEW_STALE_MS = 60_000;
const PREVIEW_MAX_CHARS = 280;

/** A preview line reads as prose: Markdown marks and code fences would only be noise here. */
export function toPreviewText(markdown: string): string | null {
  const text = markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+\.)\s+/gm, "")
    .replace(/(\*\*|__|\*|_|`|~~)/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return text.length > PREVIEW_MAX_CHARS ? `${text.slice(0, PREVIEW_MAX_CHARS)}…` : text;
}

type RepliesByServer = ReadonlyMap<string, Record<string, string | null>>;
const LastRepliesContext = createContext<RepliesByServer>(new Map());

function HostReplies({
  serverId,
  agentIds,
  onLoaded,
}: {
  serverId: string;
  agentIds: readonly string[];
  onLoaded: (serverId: string, replies: Record<string, string | null>) => void;
}) {
  const client = useHostRuntimeClient(serverId);
  const supported = useHostFeature(serverId, "agentLastReplies");
  const query = useFetchQuery({
    queryKey: ["leitstandLastReplies", serverId, agentIds.join(",")],
    enabled: Boolean(client && supported && agentIds.length > 0),
    dataShape: "value",
    staleTimeMs: PREVIEW_STALE_MS,
    queryFn: async () => client!.getAgentLastReplies(agentIds),
  });
  useEffect(() => {
    if (query.data) onLoaded(serverId, query.data);
  }, [onLoaded, query.data, serverId]);
  return null;
}

/** One stored-replies request per host for every row that shows an agent's last words. */
export function LastRepliesProvider({
  targets,
  children,
}: {
  targets: ReadonlyArray<{ serverId: string; agentId: string }>;
  children: ReactNode;
}) {
  const [replies, setReplies] = useState<RepliesByServer>(new Map());
  const byServer = useMemo(() => {
    const grouped = new Map<string, string[]>();
    for (const target of targets) {
      const ids = grouped.get(target.serverId) ?? [];
      if (!ids.includes(target.agentId)) ids.push(target.agentId);
      grouped.set(target.serverId, ids);
    }
    return grouped;
  }, [targets]);
  const onLoaded = useCallback((serverId: string, loaded: Record<string, string | null>) => {
    setReplies((current) => new Map(current).set(serverId, loaded));
  }, []);
  return (
    <LastRepliesContext.Provider value={replies}>
      {[...byServer].map(([serverId, agentIds]) => (
        <HostReplies key={serverId} serverId={serverId} agentIds={agentIds} onLoaded={onLoaded} />
      ))}
      {children}
    </LastRepliesContext.Provider>
  );
}

/** What the agent said last, so the row explains itself without opening the session. */
export function InboxReplyPreview({
  serverId,
  agentId,
  fallback,
  style,
}: {
  serverId: string;
  agentId: string | null;
  fallback: string;
  style: object;
}) {
  const stored = useContext(LastRepliesContext).get(serverId)?.[agentId ?? ""];
  const reply = stored ? toPreviewText(stored) : null;
  return (
    <Text style={style} numberOfLines={2}>
      {reply ?? fallback}
    </Text>
  );
}

/** Answering here counts as replying: the row leaves Needs you once the agent picks it up. */
export function InboxReplyInput({
  serverId,
  agentId,
  testID,
}: {
  serverId: string;
  agentId: string;
  testID: string;
}) {
  const { t } = useTranslation();
  const client = useHostRuntimeClient(serverId);
  const inputRef = useRef<EditingTextInputHandle>(null);
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "error">("idle");

  const send = useCallback(async () => {
    const message = text.trim();
    if (!client || !message || state === "sending") return;
    setState("sending");
    try {
      await client.sendAgentMessage(agentId, message);
      inputRef.current?.reset();
      setText("");
      setState("idle");
    } catch {
      setState("error");
    }
  }, [agentId, client, state, text]);

  return (
    <View style={styles.reply}>
      <EditingTextInput
        ref={inputRef}
        testID={`${testID}-reply`}
        accessibilityLabel={t("leitstand.inbox.reply.placeholder")}
        placeholder={t("leitstand.inbox.reply.placeholder")}
        placeholderTextColor={styles.placeholder.color}
        onChangeText={setText}
        onSubmitEditing={send}
        returnKeyType="send"
        style={styles.input}
      />
      <Button
        variant="secondary"
        size="sm"
        onPress={send}
        disabled={!text.trim() || state === "sending"}
        testID={`${testID}-reply-send`}
      >
        {state === "sending" ? t("leitstand.inbox.reply.sending") : t("leitstand.inbox.reply.send")}
      </Button>
      {state === "error" ? (
        <Text style={styles.error}>{t("leitstand.inbox.reply.failed")}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  reply: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    marginTop: theme.spacing[2],
  },
  input: {
    flex: 1,
    minHeight: 32,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  placeholder: {
    color: theme.colors.foregroundMuted,
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
  },
}));
