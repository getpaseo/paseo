import { useEffect, useRef } from "react";
import { useNavigation } from "@react-navigation/native";
import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { readLinkPrompt } from "@/intents/automation-link";
import { stagePendingPrompt } from "@/intents/pending-prompt-store";
import { NewWorkspaceScreen } from "@/screens/new-workspace-screen";
import { buildNewWorkspaceDraftKey } from "@/stores/draft-keys";

export default function NewWorkspaceRoute() {
  const navigation = useNavigation();
  const params = useLocalSearchParams<{
    serverId?: string;
    dir?: string;
    name?: string;
    projectId?: string;
    draftId?: string;
    prompt?: string;
  }>();
  const serverId = typeof params.serverId === "string" ? params.serverId : "";
  const sourceDirectory = typeof params.dir === "string" ? params.dir : undefined;
  const displayName = typeof params.name === "string" ? params.name : undefined;
  const projectId = typeof params.projectId === "string" ? params.projectId : undefined;
  const draftId = typeof params.draftId === "string" ? params.draftId : undefined;
  const prompt = readLinkPrompt(params.prompt);
  const stagedPromptRef = useRef<string | null>(null);
  const screenKey = JSON.stringify([
    serverId,
    sourceDirectory ?? null,
    displayName ?? null,
    projectId ?? null,
    draftId ?? null,
  ]);

  // A `prompt` query param (paseo://new?prompt=…) seeds the composer once and
  // is then dropped from the route so a remount does not append it again.
  useEffect(() => {
    if (!prompt || stagedPromptRef.current === prompt) {
      return;
    }
    stagedPromptRef.current = prompt;
    stagePendingPrompt({
      draftKey: buildNewWorkspaceDraftKey(draftId),
      prompt: { text: prompt, attachments: [] },
    });
    (navigation as unknown as { setParams: (params: { prompt?: string }) => void }).setParams({
      prompt: undefined,
    });
  }, [draftId, navigation, prompt]);

  return (
    <HostRouteBootstrapBoundary>
      <NewWorkspaceScreen
        key={screenKey}
        serverId={serverId}
        sourceDirectory={sourceDirectory}
        displayName={displayName}
        projectId={projectId}
        draftId={draftId}
      />
    </HostRouteBootstrapBoundary>
  );
}
