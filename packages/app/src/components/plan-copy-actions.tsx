import { useCallback } from "react";
import { useMutation } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";
import { Copy, Link } from "lucide-react-native";
import { Text } from "react-native";
import { useTranslation } from "react-i18next";
import { buildAgentDeepLink, type AgentDeepLinkTarget } from "@getpaseo/protocol/agent-deep-link";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useToast } from "@/contexts/toast-context";

export function PlanCopyActions({ text, source }: { text: string; source?: AgentDeepLinkTarget }) {
  return (
    <>
      <PlanCopyButton content={text} kind="content" />
      {source ? <PlanCopyButton content={buildAgentDeepLink(source)} kind="link" /> : null}
    </>
  );
}

function PlanCopyButton({ content, kind }: { content: string; kind: "content" | "link" }) {
  const { t } = useTranslation();
  const toast = useToast();
  const label = t(
    kind === "content" ? "agentStream.permission.copyContent" : "agentStream.permission.copyLink",
  );
  const copy = useMutation({
    mutationFn: async () => {
      const copied = await Clipboard.setStringAsync(content);
      if (!copied) throw new Error("Clipboard write failed");
    },
    onSuccess: () =>
      toast.copied(
        t(
          kind === "content"
            ? "agentStream.permission.contentCopied"
            : "agentStream.permission.linkCopied",
        ),
      ),
    onError: () => toast.error(t("agentStream.permission.copyFailed")),
  });
  const { mutate } = copy;
  const handlePress = useCallback(() => mutate(), [mutate]);
  return (
    <Tooltip delayDuration={250} enabledOnDesktop enabledOnMobile={false}>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          leftIcon={kind === "content" ? Copy : Link}
          accessibilityLabel={label}
          testID={`plan-copy-${kind}`}
          loading={copy.isPending}
          onPress={handlePress}
        />
      </TooltipTrigger>
      <TooltipContent side="top">
        <Text>{label}</Text>
      </TooltipContent>
    </Tooltip>
  );
}
