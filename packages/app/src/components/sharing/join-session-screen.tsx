import { useState, useRef, useCallback } from "react";
import { ActivityIndicator, Text, TextInput, View } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { Users, Link2, Check } from "lucide-react-native";
import { Button } from "@/components/ui/button";
import { useHosts, useHostMutations } from "@/runtime/host-runtime";
import { connectToDaemon } from "@/utils/test-daemon-connection";
import { setSharedSession } from "@/stores/shared-session-store";
import type { ColyseusRoom } from "@/hooks/sharing/colyseus-client";

interface JoinSessionScreenProps {
  shareToken: string;
  sessionToken: string | null;
  onJoined: (serverId: string) => void;
  onBack: () => void;
}

export function JoinSessionScreen({
  shareToken,
  sessionToken,
  onJoined,
  onBack,
}: JoinSessionScreenProps) {
  const { theme } = useUnistyles();
  const [step, setStep] = useState<"auth" | "joining" | "connect-daemon" | "connected">("auth");
  const [error, setError] = useState<string | null>(null);
  const [endpoint, setEndpoint] = useState("");
  const [isConnecting, setIsConnecting] = useState(false);
  const roomRef = useRef<ColyseusRoom | null>(null);
  const daemons = useHosts();
  const { upsertDirectConnection, upsertConnectionFromOfferUrl } = useHostMutations();

  // Step 1: Check auth
  if (!sessionToken) {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Sign in required</Text>
        <Text style={styles.description}>You need to sign in to join this shared session.</Text>
        <Button variant="outline" size="md" onPress={onBack}>
          Go back
        </Button>
      </View>
    );
  }

  // Step 2: Join Colyseus room + auto-connect to daemon via relay
  const handleJoinRoom = async () => {
    setStep("joining");
    setError(null);
    try {
      // Join Colyseus room
      const { joinSharedSession } = await import("@/hooks/sharing/colyseus-client");
      const room = await joinSharedSession({ shareToken, sessionToken });
      roomRef.current = room;

      // Fetch share info to get pairingUrl + user info
      const authUrl = __DEV__ ? "http://localhost:3002" : "https://auth.hubcode.ai";
      const shareRes = await fetch(
        `${authUrl}/api/sessions/share/${encodeURIComponent(shareToken)}`,
        {
          headers: { Authorization: `Bearer ${sessionToken}` },
        },
      );

      let shareInfo: any = null;
      if (shareRes.ok) {
        shareInfo = await shareRes.json();
      }

      // Store room globally with user info so agent panel shows sharing UI
      setSharedSession(
        room,
        shareToken,
        shareInfo?.accessLevel ?? "full_access",
        shareInfo?.currentUser ?? null,
        shareInfo?.owner?.username ?? null,
        sessionToken,
      );

      if (shareInfo?.pairingUrl) {
        // If pairing URL available, auto-connect via relay
        try {
          const profile = await upsertConnectionFromOfferUrl(shareInfo.pairingUrl);
          onJoined(profile.serverId ?? daemons[0]?.serverId ?? "");
          return;
        } catch {
          // Fallback to manual connection
        }
      }

      // No pairing URL or connection failed — show manual form
      setStep("connect-daemon");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to join session");
      setStep("auth");
    }
  };

  // Step 3: Connect to host's daemon
  const handleConnectDaemon = async () => {
    if (!endpoint.trim()) return;
    setIsConnecting(true);
    setError(null);
    try {
      const { client, serverId, hostname } = await connectToDaemon({
        id: "shared-session",
        type: "directTcp",
        endpoint: endpoint.trim(),
      });
      await client.close().catch(() => undefined);

      await upsertDirectConnection({
        serverId,
        endpoint: endpoint.trim(),
        label: hostname ?? undefined,
      });

      setStep("connected");

      // Navigate to the host's workspace
      onJoined(serverId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect to daemon");
    } finally {
      setIsConnecting(false);
    }
  };

  // Already connected to a daemon? Skip connection step
  const handleUseExistingDaemon = () => {
    if (daemons.length > 0) {
      onJoined(daemons[0].serverId);
    }
  };

  if (step === "joining") {
    return (
      <View style={styles.container}>
        <ActivityIndicator size="large" color={theme.colors.accent} />
        <Text style={styles.description}>Joining shared session...</Text>
      </View>
    );
  }

  if (step === "connect-daemon") {
    return (
      <View style={styles.container}>
        <View style={[styles.badge, { backgroundColor: theme.colors.success + "20" }]}>
          <View style={[styles.dot, { backgroundColor: theme.colors.success }]} />
          <Text style={[styles.badgeText, { color: theme.colors.success }]}>Room joined</Text>
        </View>

        <Text style={styles.title}>Connect to host</Text>
        <Text style={styles.description}>
          Enter the host's daemon address to see the agent session.
        </Text>

        {daemons.length > 0 && (
          <View style={styles.existingDaemon}>
            <Text style={styles.existingLabel}>Already connected to:</Text>
            <Button
              variant="default"
              size="md"
              leftIcon={<Check size={14} color={theme.colors.accentForeground} />}
              onPress={handleUseExistingDaemon}
            >
              Use {daemons[0].label || daemons[0].serverId}
            </Button>
          </View>
        )}

        <View style={styles.separator}>
          <View style={styles.separatorLine} />
          <Text style={styles.separatorText}>or connect to a new host</Text>
          <View style={styles.separatorLine} />
        </View>

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

  // Initial: show join button
  return (
    <View style={styles.container}>
      <View style={styles.badge}>
        <Users size={16} color={theme.colors.accent} />
        <Text style={styles.badgeText}>Shared session</Text>
      </View>

      <Text style={styles.title}>Ready to join</Text>
      <Text style={styles.description}>You have been invited to a shared agent session.</Text>

      {error && <Text style={styles.error}>{error}</Text>}

      <View style={styles.actions}>
        <Button variant="default" size="lg" onPress={() => void handleJoinRoom()}>
          Join session
        </Button>
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
  existingDaemon: {
    alignItems: "center",
    gap: theme.spacing[2],
    marginTop: theme.spacing[2],
  },
  existingLabel: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
  },
  separator: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    width: "100%",
    maxWidth: 400,
    marginVertical: theme.spacing[2],
  },
  separatorLine: {
    flex: 1,
    height: 1,
    backgroundColor: theme.colors.border,
  },
  separatorText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
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
