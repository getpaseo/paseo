import { useEffect } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { JoinWorkspaceScreen } from "@/components/sharing/join-workspace-screen";
import { useAuthSession } from "@/desktop/hooks/use-auth-session";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import { setSharedMediaPreferences } from "@/stores/shared-media-preferences";

export default function JoinWorkspaceRoute() {
  const { token, st, video, audio, videoDevice, audioDevice } = useLocalSearchParams<{
    token: string;
    st?: string;
    video?: string;
    audio?: string;
    videoDevice?: string;
    audioDevice?: string;
  }>();
  const router = useRouter();
  const { session } = useAuthSession();

  const sessionToken = session?.sessionToken ?? st ?? null;

  // Capture the camera/mic preferences the user picked on the pre-join screen
  // (auth-server `/join-workspace/[token]`). The `0` means "start disabled".
  // Device IDs are best-effort — the app falls back to system default if the
  // picked device isn't present on this machine.
  useEffect(() => {
    setSharedMediaPreferences({
      videoEnabled: video === "0" ? false : true,
      audioEnabled: audio === "0" ? false : true,
      videoDeviceId: typeof videoDevice === "string" && videoDevice.length > 0 ? videoDevice : null,
      audioDeviceId: typeof audioDevice === "string" && audioDevice.length > 0 ? audioDevice : null,
    });
  }, [video, audio, videoDevice, audioDevice]);

  return (
    <JoinWorkspaceScreen
      shareToken={token ?? ""}
      sessionToken={sessionToken}
      onJoined={({ serverId, workspaceId }) =>
        router.replace(buildHostWorkspaceRoute(serverId, workspaceId))
      }
      onBack={() => router.replace("/")}
    />
  );
}
