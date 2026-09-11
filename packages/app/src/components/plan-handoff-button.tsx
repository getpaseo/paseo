import { useCallback } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { ArrowRight } from "lucide-react-native";
import { buildAgentDeepLink } from "@getpaseo/protocol/agent-deep-link";
import { Button } from "@/components/ui/button";
import { useToast } from "@/contexts/toast-context";
import { useSessionStore } from "@/stores/session-store";
import { navigateToAgent } from "@/utils/navigate-to-agent";

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
      const created = await session.client.createAgent({
        workspaceId: agent.workspaceId,
        config: {
          provider: agent.provider,
          cwd: agent.cwd,
          model: agent.model ?? undefined,
          thinkingOptionId: agent.thinkingOptionId ?? undefined,
        },
        initialPrompt: t("agentStream.permission.handoffPrompt"),
        attachments: [
          {
            type: "text",
            mimeType: "text/plain",
            title: t("agentStream.permission.proposedPlan"),
            text: `${text}\n\nSource: ${buildAgentDeepLink({ serverId, agentId })}`,
          },
        ],
      });
      navigateToAgent({ serverId, agentId: created.id, workspaceId: agent.workspaceId });
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
