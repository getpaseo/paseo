import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Text, TextInput, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Check, Link2, Users } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { useHostMutations, useHosts } from "@/runtime/host-runtime";
import { connectToDaemon } from "@/utils/test-daemon-connection";
import { primeShareScope, setSharedSession } from "@/stores/shared-session-store";
import { useAuthSession } from "@/desktop/hooks/use-auth-session";
import { getIsElectron, isWeb } from "@/constants/platform";
import type { ColyseusRoom } from "@/hooks/sharing/colyseus-client";

interface ShareInfo {
  shareId: string;
  token: string;
  workspaceId: string;
  serverId: string;
  projectId: string;
  projectName: string;
  workspaceName: string;
  orgId: string;
  accessLevel: "read_only" | "full_access" | string;
  pairingUrl: string | null;
  owner: { userId: string; name: string; email: string; image: string | null };
  currentUser?: {
    userId: string;
    name?: string;
    email?: string;
    image?: string | null;
    isOwner: boolean;
  };
}

interface JoinWorkspaceScreenProps {
  shareToken: string;
  sessionToken: string | null;
  onJoined: (input: { serverId: string; workspaceId: string }) => void;
  onBack: () => void;
}

type Step = "fetching" | "ready" | "joining" | "connect-daemon";

export function JoinWorkspaceScreen({
  shareToken,
  sessionToken,
  onJoined,
  onBack,
}: JoinWorkspaceScreenProps) {
  const { theme } = useUnistyles();
  const [step, setStep] = useState<Step>("fetching");
  const [error, setError] = useState<string | null>(null);
  const [shareInfo, setShareInfo] = useState<ShareInfo | null>(null);
  const [endpoint, setEndpoint] = useState("");
  const [isConnecting, setIsConnecting] = useState(false);
  const didFetchRef = useRef(false);
  const roomRef = useRef<ColyseusRoom | null>(null);
  const daemons = useHosts();
  const { upsertDirectConnection, upsertConnectionFromOfferUrl } = useHostMutations();
  const { session: authSession } = useAuthSession();

  const joinColyseusAndNavigate = useCallback(
    async (info: ShareInfo, nextServerId: string) => {
      try {
        const { joinSharedSession } = await import("@/hooks/sharing/colyseus-client");
        const room = await joinSharedSession({ shareToken, sessionToken: sessionToken ?? "" });
        roomRef.current = room;

        const me = authSession?.user;
        const currentUserName =
          info.currentUser?.name || me?.username || info.owner?.name || "Guest";
        const currentUserAvatar = info.currentUser?.image || me?.avatarUrl || "";
        setSharedSession(
          room,
          shareToken,
          info.accessLevel,
          info.currentUser
            ? {
                userId: info.currentUser.userId,
                username: currentUserName,
                avatarUrl: currentUserAvatar,
                isOwner: info.currentUser.isOwner,
              }
            : null,
          info.owner?.name ?? null,
          sessionToken,
          { serverId: nextServerId, workspaceId: info.workspaceId },
        );
      } catch (err) {
        console.warn("[join-workspace] Colyseus join failed (non-fatal):", err);
      }
      onJoined({ serverId: nextServerId, workspaceId: info.workspaceId });
    },
    [shareToken, sessionToken, onJoined, authSession?.user],
  );

  const connectAndNavigate = useCallback(
    async (info: ShareInfo) => {
      setStep("joining");
      setError(null);

      // Seed share scope/credentials BEFORE creating the daemon client so the
      // initial WS hello carries shareToken + shareSessionToken. Without this,
      // the daemon would briefly treat the recipient as an unrestricted owner.
      const me = authSession?.user;
      const currentUserName = info.currentUser?.name || me?.username || info.owner?.name || "Guest";
      const currentUserAvatar = info.currentUser?.image || me?.avatarUrl || "";
      primeShareScope({
        shareToken,
        sessionToken: sessionToken ?? "",
        accessLevel: info.accessLevel,
        currentUser: info.currentUser
          ? {
              userId: info.currentUser.userId,
              username: currentUserName,
              avatarUrl: currentUserAvatar,
              isOwner: info.currentUser.isOwner,
            }
          : null,
        ownerName: info.owner?.name ?? null,
        scope: { serverId: info.serverId, workspaceId: info.workspaceId },
      });

      // 1) Already connected to the owner's daemon? Use it directly.
      const existing = daemons.find((d) => d.serverId === info.serverId);
      if (existing) {
        await joinColyseusAndNavigate(info, existing.serverId);
        return;
      }

      // 2) Try pairing URL (relay connection).
      if (info.pairingUrl) {
        try {
          const profile = await upsertConnectionFromOfferUrl(info.pairingUrl);
          const nextServerId = profile.serverId ?? info.serverId;
          await joinColyseusAndNavigate(info, nextServerId);
          return;
        } catch (err) {
          console.warn("[join-workspace] pairing-url connection failed:", err);
        }
      }

      // 3) Fallback: ask for daemon endpoint manually.
      setStep("connect-daemon");
    },
    [
      authSession?.user,
      daemons,
      joinColyseusAndNavigate,
      sessionToken,
      shareToken,
      upsertConnectionFromOfferUrl,
    ],
  );

  const fetchShare = useCallback(async () => {
    if (!shareToken) return;
    // Desktop (Electron) requires a bearer sessionToken; web/mobile can rely
    // on Better Auth cookies from the auth-server origin via credentials:
    // "include" — no sessionToken needed when the user is signed in there.
    if (getIsElectron() && !sessionToken) return;
    setStep("fetching");
    setError(null);
    try {
      const authUrl = __DEV__ ? "http://localhost:3002" : "https://auth.hubcode.ai";
      const response = await fetch(
        `${authUrl}/api/workspaces/share/${encodeURIComponent(shareToken)}`,
        {
          headers: sessionToken ? { Authorization: `Bearer ${sessionToken}` } : undefined,
          credentials: "include",
        },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Failed to fetch share (${response.status})`);
      }
      const info = (await response.json()) as ShareInfo;
      setShareInfo(info);
      setStep("ready");
      // Auto-advance: connect + join colyseus + navigate
      await connectAndNavigate(info);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch share");
      setStep("ready");
    }
  }, [shareToken, sessionToken, connectAndNavigate]);

  useEffect(() => {
    if (didFetchRef.current) return;
    // Web: always attempt fetch (server accepts cookie auth + will 401 if not
    // signed in, which we surface below). Desktop: wait for the bearer token.
    if (getIsElectron() && !sessionToken) return;
    didFetchRef.current = true;
    void fetchShare();
  }, [fetchShare, sessionToken]);

  const handleConnectDaemon = useCallback(async () => {
    if (!endpoint.trim() || !shareInfo) return;
    setIsConnecting(true);
    setError(null);
    try {
      const { client, serverId, hostname } = await connectToDaemon({
        id: "shared-workspace",
        type: "directTcp",
        endpoint: endpoint.trim(),
      });
      await client.close().catch(() => undefined);

      await upsertDirectConnection({
        serverId,
        endpoint: endpoint.trim(),
        label: hostname ?? undefined,
      });

      await joinColyseusAndNavigate(shareInfo, serverId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect to daemon");
    } finally {
      setIsConnecting(false);
    }
  }, [endpoint, shareInfo, upsertDirectConnection, joinColyseusAndNavigate]);

  // Desktop path still requires the bearer token before we attempt anything.
  // Web path falls through to fetchShare, which uses cookie auth and will
  // surface a 401 "Sign in required" error below if the user isn't signed in.
  if (getIsElectron() && !sessionToken) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Sign in required</Text>
        <Text style={styles.description}>
          You need to sign in to open this shared workspace. You must also be a member of the
          owner&apos;s organization and be on the invite list.
        </Text>
        <Button variant="outline" size="md" onPress={onBack}>
          Go back
        </Button>
      </View>
    );
  }

  const handleSignIn = () => {
    if (!isWeb) return;
    const authUrl = __DEV__ ? "http://localhost:3002" : "https://auth.hubcode.ai";
    const returnUrl = encodeURIComponent(window.location.href);
    window.location.href = `${authUrl}/sign-in?callbackURL=${returnUrl}`;
  };

  if (step === "fetching" || step === "joining") {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="large" color={theme.colors.accent} />
        <Text style={styles.description}>
          {step === "fetching" ? "Loading share details..." : "Connecting to workspace..."}
        </Text>
      </View>
    );
  }

  if (step === "connect-daemon" && shareInfo) {
    return (
      <View style={styles.container}>
        <View style={[styles.badge, { backgroundColor: theme.colors.success + "20" }]}>
          <View style={[styles.dot, { backgroundColor: theme.colors.success }]} />
          <Text style={[styles.badgeText, { color: theme.colors.success }]}>Share validated</Text>
        </View>

        <Text style={styles.title}>Owner is offline</Text>
        <Text style={styles.description}>
          Could not reach the owner&apos;s daemon automatically. Enter a direct address if you know
          one, or try again later.
        </Text>

        <View style={styles.inputRow}>
          <TextInput
            style={[styles.input, { color: theme.colors.foreground }]}
            value={endpoint}
            onChangeText={setEndpoint}
            placeholder="localhost:6767"
            placeholderTextColor={theme.colors.foregroundMuted}
            autoCapitalize="none"
            autoFocus
          />
          <Button
            variant="default"
            size="md"
            leftIcon={<Link2 size={14} color={theme.colors.accentForeground} />}
            onPress={() => void handleConnectDaemon()}
            disabled={isConnecting || !endpoint.trim()}
          >
            {isConnecting ? "Connecting..." : "Connect"}
          </Button>
        </View>

        {error && <Text style={styles.error}>{error}</Text>}

        <Button variant="ghost" size="sm" onPress={onBack}>
          Cancel
        </Button>
      </View>
    );
  }

  // Ready state (has shareInfo but not auto-advanced yet, or fetch error)
  return (
    <View style={styles.container}>
      <View style={styles.badge}>
        <Users size={16} color={theme.colors.accent} />
        <Text style={styles.badgeText}>
          {shareInfo?.accessLevel === "full_access" ? "Full access" : "View only"}
        </Text>
      </View>

      <Text style={styles.title}>{shareInfo ? shareInfo.workspaceName : "Shared workspace"}</Text>
      {shareInfo ? (
        <Text style={styles.description}>
          {shareInfo.projectName} · shared by {shareInfo.owner.name}
        </Text>
      ) : null}

      {error && <Text style={styles.error}>{error}</Text>}

      <View style={styles.actions}>
        {isWeb && !shareInfo && error ? (
          <Button variant="default" size="lg" onPress={handleSignIn}>
            Sign in to continue
          </Button>
        ) : (
          <Button
            variant="default"
            size="lg"
            onPress={() => shareInfo && void connectAndNavigate(shareInfo)}
            disabled={!shareInfo}
            leftIcon={<Check size={14} color={theme.colors.accentForeground} />}
          >
            Open workspace
          </Button>
        )}
        <Button variant="ghost" size="sm" onPress={onBack}>
          Go back
        </Button>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[6],
    gap: theme.spacing[3],
    backgroundColor: theme.colors.surface0,
  },
  badge: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface2,
  },
  badgeText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
  },
  description: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
    maxWidth: 400,
  },
  error: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
  },
  actions: {
    gap: theme.spacing[2],
    alignItems: "center",
    marginTop: theme.spacing[3],
  },
  inputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    width: "100%",
    maxWidth: 400,
  },
  input: {
    flex: 1,
    backgroundColor: theme.colors.surface1,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[3],
    fontSize: theme.fontSize.sm,
  },
}));
