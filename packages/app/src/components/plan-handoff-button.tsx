import { useCallback } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ArrowRight } from "lucide-react-native";
import { buildAgentDeepLink } from "@getpaseo/protocol/agent-deep-link";
import { Button } from "@/components/ui/button";
import { useToast } from "@/contexts/toast-context";
import { useSessionStore } from "@/stores/session-store";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useDraftStore } from "@/stores/draft-store";
import { buildDraftStoreKey, generateDraftId } from "@/stores/draft-keys";

export function PlanHandoffButton({
  serverId,
  agentId,
  text,
  disabled,
}: {
  serverId: string;
  agentId: string;
  text: string;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const toast = useToast();
  const handoff = useMutation({
    mutationFn: async () => {
      const session = useSessionStore.getState().sessions[serverId];
      const agent = session?.agents.get(agentId);
      if (!session?.client || !agent?.workspaceId) {
        throw new Error(t("agentStream.permission.handoffFailed"));
      }
      const draftId = generateDraftId();
      const draftKey = buildDraftStoreKey({ serverId, agentId, draftId });
      useDraftStore.getState().saveDraftInput({
        draftKey,
        draft: {
          text: `${t("agentStream.permission.handoffPrompt")}\n\n${text}\n\nSource: ${buildAgentDeepLink({ serverId, agentId })}`,
          attachments: [],
        },
      });
      navigateToWorkspace({
        serverId,
        workspaceId: agent.workspaceId,
        target: {
          kind: "draft",
          draftId,
          setup: {
            provider: agent.provider,
            cwd: agent.cwd,
            model: agent.model,
            thinkingOptionId: agent.thinkingOptionId ?? null,
            modeId: null,
            featureValues: Object.fromEntries(
              (agent.features ?? []).map((feature) => [feature.id, feature.value]),
            ),
          },
        },
      });
    },
    onError: () => toast.error(t("agentStream.permission.handoffFailed")),
  });
  const { mutate } = handoff;
  const handlePress = useCallback(() => mutate(), [mutate]);
  return (
    <Button
      variant="outline"
      size="sm"
      leftIcon={ArrowRight}
      loading={handoff.isPending}
      disabled={disabled || handoff.isSuccess}
      onPress={handlePress}
      testID="permission-plan-handoff"
    >
      {t(handoff.isSuccess ? "agentStream.permission.handedOff" : "agentStream.permission.handOff")}
    </Button>
  );
}
