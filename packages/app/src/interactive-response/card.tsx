import { InteractiveStateWriter } from "./state-writer";
import {
  useEffect,
  useRef,
  useState,
  useCallback,
  useMemo,
  Component,
  type ReactNode,
} from "react";
import { Text, View } from "react-native";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Renderer } from "@openuidev/react-lang";
import { useTranslation } from "react-i18next";
import { useFetchQuery } from "@/data/query";
import {
  InteractiveDocumentSchema,
  validateInteractiveSource,
  type InteractiveDocument,
  type InteractiveState,
} from "@getpaseo/protocol/interactive-response";
import type { ToolCallItem } from "@/types/stream";
import { Button } from "@/components/ui/button";
import { describeToolCall } from "@/tool-calls/detail-level/grouping";
import { useInteractiveConversation } from "./context";
import { interactiveToolDocumentId } from "./tool-result";
import { InteractiveFields, library } from "./library";
import { styles } from "./styles";
import { sendConversationAction } from "./send";

class RenderBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
export function InteractiveResponseCard({ item }: { item: ToolCallItem }) {
  const context = useInteractiveConversation();
  const { t } = useTranslation();
  const descriptor = describeToolCall(item);
  const id = interactiveToolDocumentId(item);
  const query = useFetchQuery({
    dataShape: "value",
    staleTimeMs: 0,
    queryKey: ["interactive-response", context?.serverId, context?.agentId, id],
    enabled: !!id && !!context?.client && context.supported && descriptor.status === "completed",
    queryFn: async () => {
      const result = await context!.client!.getInteractiveResponse(context!.agentId, id!);
      if (result.error || !result.document)
        throw new Error(result.error ?? t("interactive.loadError"));
      const document = InteractiveDocumentSchema.parse(result.document);
      validateInteractiveSource(document.source);
      return document;
    },
  });
  const { refetch } = query;
  const reload = useCallback(() => {
    void refetch();
  }, [refetch]);
  if (!context?.supported) return <Text style={styles.error}>{t("interactive.updateHost")}</Text>;
  if (descriptor.status === "running" || descriptor.status === "executing")
    return <Text style={styles.muted}>{t("interactive.generating")}</Text>;
  if (descriptor.status !== "completed" || !id)
    return (
      <Text accessibilityRole="alert" style={styles.error}>
        {t("interactive.generationError")}
      </Text>
    );
  if (query.isError)
    return (
      <View>
        <Text accessibilityRole="alert" style={styles.error}>
          {String(query.error.message)}
        </Text>
        <Button size="sm" onPress={reload}>
          {t("interactive.retry")}
        </Button>
      </View>
    );
  if (!query.data) return <Text style={styles.muted}>{t("interactive.loading")}</Text>;
  return (
    <DocumentView key={`${id}:${query.dataUpdatedAt}`} document={query.data} reload={reload} />
  );
}
function DocumentView({
  document,
  reload,
}: {
  document: InteractiveDocument;
  reload: () => unknown;
}) {
  const context = useInteractiveConversation()!;
  const { t } = useTranslation();
  const [state, setState] = useState(document.state);
  const latestState = useRef(document.state);
  const blocked = useRef(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [status, setStatus] = useState<"idle" | "sent" | "queued">("idle");
  const request = useRef<{
    id: string;
    text: string;
    interactiveReference: { documentId: string; revision: number };
  } | null>(null);
  const sending = useRef(false);
  const alive = useRef(true);
  const [writer] = useState(
    () =>
      new InteractiveStateWriter(
        document.revision,
        async (revision, next) => {
          const result = await context.client!.updateInteractiveResponse(
            context.agentId,
            document.id,
            revision,
            next,
          );
          if (result.error || !result.document)
            throw new Error(result.error ?? t("interactive.saveError"));
          return result.document.revision;
        },
        (failure) => {
          blocked.current = true;
          if (alive.current) setError(failure.message);
        },
      ),
  );
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const change = useCallback(
    (name: string, value: string | number) => {
      if (
        blocked.current ||
        sending.current ||
        context.readOnly ||
        status !== "idle" ||
        request.current
      )
        return;
      const next: InteractiveState = { ...latestState.current, [name]: value };
      latestState.current = next;
      setState(next);
      writer.write(next);
    },
    [context.readOnly, status, writer],
  );
  const send = useCallback(async () => {
    if (sending.current) return;
    sending.current = true;
    setPending(true);
    setError("");
    try {
      await writer.flush();
      if (blocked.current) throw new Error(t("interactive.reloadConflict"));
      request.current ??= {
        id: crypto.randomUUID(),
        text: `${document.title} — ${document.summary}\n${Object.entries(latestState.current)
          .map(([key, value]) => `${key}: ${String(value)}`)
          .join("\n")}`,
        interactiveReference: { documentId: document.id, revision: writer.revision },
      };
      setStatus(await sendConversationAction(context, request.current));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      sending.current = false;
      setPending(false);
    }
  }, [context, document, t, writer]);
  const header = useMemo(
    () => ({ title: document.title, subtitle: document.summary }),
    [document.title, document.summary],
  );
  const open = useCallback(() => setExpanded(true), []);
  const close = useCallback(() => setExpanded(false), []);
  const retry = useCallback(() => {
    if (blocked.current) reload();
    else void send();
  }, [reload, send]);
  const fields = useMemo(
    () => ({
      state,
      change,
      disabled: context.readOnly || pending || status !== "idle" || Boolean(error),
    }),
    [state, change, context.readOnly, pending, status, error],
  );
  const fallback = useMemo(
    () => (
      <Text accessibilityRole="alert" style={styles.error}>
        {t("interactive.renderError")}
      </Text>
    ),
    [t],
  );
  const label = status === "idle" ? "interactive.send" : (`interactive.${status}` as const);
  const content = (
    <RenderBoundary fallback={fallback}>
      <InteractiveFields.Provider value={fields}>
        <Renderer
          response={document.source}
          library={library}
          isStreaming={false}
          publishObservability={false}
        />
      </InteractiveFields.Provider>
    </RenderBoundary>
  );
  return (
    <View style={styles.card} testID="interactive-response">
      <Text style={styles.title}>{document.title}</Text>
      <Text style={styles.muted}>{document.summary}</Text>
      {!expanded ? content : null}
      <View style={styles.row}>
        <Button size="sm" variant="ghost" onPress={open}>
          {t("interactive.expand")}
        </Button>
        {!context.readOnly ? (
          <Button
            size="sm"
            onPress={send}
            loading={pending}
            disabled={status !== "idle" || !context.client}
          >
            {t(label)}
          </Button>
        ) : null}
      </View>
      {error ? (
        <View>
          <Text accessibilityRole="alert" style={styles.error}>
            {error}
          </Text>
          <Button size="sm" variant="ghost" onPress={reload}>
            {t("interactive.reload")}
          </Button>
          {!blocked.current ? (
            <Button size="sm" onPress={retry}>
              {t("interactive.retry")}
            </Button>
          ) : null}
        </View>
      ) : null}
      <AdaptiveModalSheet
        header={header}
        visible={expanded}
        onClose={close}
        desktopMaxWidth={1000}
        snapPoints={EXPANDED_SNAP_POINTS}
        testID="interactive-expanded"
      >
        {expanded ? content : null}
      </AdaptiveModalSheet>
    </View>
  );
}

const EXPANDED_SNAP_POINTS = ["92%"];
