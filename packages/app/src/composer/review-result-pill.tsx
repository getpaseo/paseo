import { Check } from "lucide-react-native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text } from "react-native";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/shallow";
import { Button } from "@/components/ui/button";
import { useMarkAgentDone } from "@/hooks/use-mark-agent-done";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { selectAgentTurnPresentation, useSessionStore } from "@/stores/session-store";
import { keepEditorFocused } from "./keyboard-scope";
import { composerPillStyles } from "./pill-styles";
import { ComposerTrackMark } from "./tracks";

export function ReviewResultPill({ serverId, agentId }: { serverId: string; agentId: string }) {
  const markDone = useMarkAgentDone(serverId);
  const connected = useHostRuntimeIsConnected(serverId);
  const { resultId, needsFollowUp, running } = useSessionStore(
    useShallow((state) => {
      const session = state.sessions[serverId];
      const agent = session?.agents.get(agentId) ?? session?.agentDetails.get(agentId);
      const unreadFinish = agent?.requiresAttention && agent.attentionReason === "finished";
      return {
        resultId: agent?.reviewResult?.id,
        needsFollowUp: Boolean(agent?.reviewResult?.followUpAt) && !unreadFinish,
        running: selectAgentTurnPresentation(session, agentId).isActive,
      };
    }),
  );
  // The daemon can clear the result before the RPC resolves. Keep that result's
  // feedback mounted; a newer result gets its own button and request state.
  const [submittedId, setSubmittedId] = useState<string | null>(null);
  const id = resultId ?? submittedId;
  if (!id || !markDone || running) return null;
  return (
    <ReviewResultAction
      key={id}
      agentId={agentId}
      resultId={id}
      hasResult={Boolean(resultId)}
      needsFollowUp={needsFollowUp}
      connected={connected}
      onSubmit={setSubmittedId}
      markDone={markDone}
    />
  );
}

type SaveState =
  | { phase: "idle" | "success" | "dismissed" }
  | { phase: "pending"; needsFollowUp: boolean };

// Saving and Done are live feedback even though the button no longer accepts presses.
const feedbackStyle = { opacity: 1 } as const;

function ReviewResultAction({
  agentId,
  resultId,
  hasResult,
  needsFollowUp,
  connected,
  onSubmit,
  markDone,
}: {
  agentId: string;
  resultId: string;
  hasResult: boolean;
  needsFollowUp: boolean;
  connected: boolean;
  onSubmit: (resultId: string) => void;
  markDone: (agentId: string, resultId: string) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<SaveState>({ phase: "idle" });
  const submitted = useRef(false);
  const press = useCallback(async () => {
    if (submitted.current || !hasResult || !connected) return;
    submitted.current = true;
    onSubmit(resultId);
    setState({ phase: "pending", needsFollowUp });
    const saved = await markDone(agentId, resultId);
    submitted.current = saved;
    setState({ phase: saved ? "success" : "idle" });
  }, [agentId, connected, hasResult, markDone, needsFollowUp, onSubmit, resultId]);
  useEffect(() => {
    if (state.phase !== "success") return;
    const timer = setTimeout(() => setState({ phase: "dismissed" }), 1200);
    return () => clearTimeout(timer);
  }, [state.phase]);
  const pending = state.phase === "pending";
  const success = state.phase === "success";
  const showingFeedback = pending || success;
  const bodyStyle = useMemo(
    () => [
      composerPillStyles.body,
      composerPillStyles.actionTarget,
      showingFeedback && feedbackStyle,
    ],
    [showingFeedback],
  );
  const mark = useMemo(
    () => <ComposerTrackMark bucket={needsFollowUp ? "needs_follow_up" : "attention"} />,
    [needsFollowUp],
  );
  if (state.phase === "dismissed" || (state.phase === "idle" && !hasResult)) return null;

  const showFollowUp = pending ? state.needsFollowUp : needsFollowUp;
  const status = t(
    showFollowUp ? "sidebar.statusBucket.needsFollowUp" : "sidebar.statusBucket.readyToReview",
  );
  const action = t(pending ? "common.states.saving" : "sidebar.workspace.actions.markDone");
  const label = success ? t("sidebar.statusBucket.done") : `${status} · ${action}`;
  return (
    <Button
      testID="composer-mark-done"
      size="sm"
      variant="secondary"
      style={bodyStyle}
      hoverStyle={composerPillStyles.bodyActive}
      accessibilityLabel={label}
      accessibilityLiveRegion="polite"
      numberOfLines={1}
      loading={pending}
      disabled={!connected || state.phase !== "idle"}
      onPointerDown={keepEditorFocused}
      onPress={press}
      leftIcon={success ? Check : mark}
    >
      {success ? (
        label
      ) : (
        <>
          <Text style={composerPillStyles.label}>{status} · </Text>
          {action}
        </>
      )}
    </Button>
  );
}
