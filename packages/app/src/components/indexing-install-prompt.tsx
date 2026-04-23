import { useCallback, useEffect, useRef, useState } from "react";
import { Animated, Easing, Pressable, Text, View } from "react-native";
import { useUnistyles } from "react-native-unistyles";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Sparkles } from "lucide-react-native";

import { Button } from "@/components/ui/button";
import { isWeb } from "@/constants/platform";
import { IndexingProvider, useIndexing } from "@/hooks/use-indexing";

/**
 * One-time-per-user prompt that appears when:
 *   1. A daemon is connected, AND
 *   2. `code-review-graph` isn't installed on that daemon, AND
 *   3. The user hasn't clicked "Don't show again" before.
 *
 * Renders a small, skippable overlay offering to install crg so every project
 * they open gets indexed automatically — without any per-project setup.
 *
 * The copy emphasizes cost: indexed repos let agents answer architecture /
 * impact questions from a structural graph instead of reading every file
 * through the LLM, which directly reduces token spend (user's own API bill).
 */

const STORAGE_KEY = "indexing-install-prompt.v1"; // "skipped" | "dismissed-forever"

export function IndexingInstallPrompt({ serverId }: { serverId: string | null }) {
  if (!serverId) return null;
  return (
    <IndexingProvider serverId={serverId}>
      <IndexingInstallPromptInner />
    </IndexingProvider>
  );
}

function IndexingInstallPromptInner() {
  const { theme } = useUnistyles();
  const indexing = useIndexing();
  const [persistedDecision, setPersistedDecision] = useState<string | null>(null);
  const [sessionDismissed, setSessionDismissed] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [installLog, setInstallLog] = useState("");
  const [installStage, setInstallStage] = useState<string>("Preparing…");
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  // Sticky per-session: once the user clicks Install, don't show the
  // marketing pitch again in this session even if detection briefly flips
  // back to "not installed" (race between install success + redetect).
  const [attempted, setAttempted] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  // Bridge state: kept true for a short window after install finishes so
  // the pill stays visible while we wait for the crg subprocess to connect
  // and kick off the first reindex (normally 5–10s). Without this, the
  // pill hides and then re-shows once a workspace enters phase=indexing —
  // visually jarring and looks like nothing happened.
  const [waitingForIndex, setWaitingForIndex] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY)
      .then((v) => setPersistedDecision(v))
      .catch(() => setPersistedDecision(null));
  }, []);

  // Tick once a second while installing so the elapsed counter re-renders.
  useEffect(() => {
    if (!installing) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [installing]);
  // Reference the tick to silence TS unused warnings without changing behavior.
  void tick;

  const canAutoInstall = !!indexing.detection && !indexing.detection.codeReviewGraph.installed;
  // After install, keep showing the pill in "Indexing…" mode until every
  // enabled workspace is done (ready or error). User gets visual
  // continuity from Install → Indexing → done, regardless of which screen
  // they're on.
  const activeIndex = indexing.entries.find(
    (e) => e.indexing?.enabled && e.indexing.status.phase === "indexing",
  );
  const showPostInstallProgress = attempted && !canAutoInstall && !!activeIndex;

  // Visibility rules (priority top to bottom):
  //   1. Never if user dismissed forever or dismissed this session.
  //   2. Always while installing — show the compact pill with progress.
  //   3. Always if install just failed — show a retry state instead of the
  //      marketing pitch (user already made the decision).
  //   4. Post-install indexing in progress — morph the pill into a status
  //      indicator so user sees the full flow without jumping to Settings.
  //   5. Hide if install succeeded and nothing's indexing anymore.
  //   6. Hide if the user clicked Install at least once this session, even
  //      if detection still lags behind — don't re-pitch.
  //   7. Otherwise, show the marketing pitch.
  const shouldShow =
    indexing.isConnected &&
    persistedDecision !== "dismissed-forever" &&
    !sessionDismissed &&
    (installing || !!lastError || showPostInstallProgress || (canAutoInstall && !attempted));

  const handleInstall = useCallback(async () => {
    setInstalling(true);
    setAttempted(true);
    setLastError(null);
    setInstallLog("");
    setInstallStage("Preparing…");
    setStartedAt(Date.now());
    const onEvent = (event: unknown) => {
      const e = event as {
        type: string;
        text?: string;
        command?: string;
        args?: string[];
        success?: boolean;
        error?: string;
        strategy?: { kind: string };
      };
      if (e.type === "plan" && e.strategy) {
        setInstallStage(`Using ${e.strategy.kind}`);
        setInstallLog((prev) => prev + `▸ Strategy: ${e.strategy?.kind}\n`);
      } else if (e.type === "step-started") {
        const label = `${e.command ?? ""} ${(e.args ?? []).join(" ")}`.trim();
        setInstallStage(label || "Running…");
        setInstallLog((prev) => prev + `$ ${label}\n`);
      } else if (e.type === "step-output" && e.text) {
        setInstallLog((prev) => (prev + e.text).slice(-2000));
      } else if (e.type === "completed") {
        setInstallStage(e.success ? "Finalizing…" : `Failed: ${e.error ?? "unknown"}`);
        setInstallLog((prev) => prev + (e.success ? "\n✔ Done" : `\n✘ ${e.error ?? "Failed"}`));
      }
    };
    try {
      const outcome = await indexing.install(onEvent);
      if (!outcome.success) {
        setLastError(outcome.error ?? "Install failed");
      } else {
        await AsyncStorage.setItem(STORAGE_KEY, "installed").catch(() => undefined);
      }
      // Always re-detect so Settings reflects reality. Don't let a failing
      // redetect blank out the user's decision.
      await indexing.redetect().catch(() => undefined);
    } catch (err) {
      setLastError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(false);
    }
  }, [indexing]);

  const handleSkip = useCallback(() => {
    setSessionDismissed(true);
  }, []);

  const handleDismissForever = useCallback(async () => {
    await AsyncStorage.setItem(STORAGE_KEY, "dismissed-forever").catch(() => undefined);
    setPersistedDecision("dismissed-forever");
  }, []);

  if (!shouldShow) return null;

  // Error mode — install failed. Show the real message so the user can
  // decide (retry, dismiss, or copy the message to debug manually). Takes
  // priority over the marketing pitch since the user already opted in.
  if (lastError && !installing) {
    return (
      <View style={compactPillStyle(theme)}>
        <View style={compactHeaderRow}>
          <Text style={[compactHeaderText(theme), { color: theme.colors.foreground }]}>
            Install failed
          </Text>
        </View>
        <Text
          selectable
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 11,
            lineHeight: 15,
            fontFamily: "monospace",
          }}
        >
          {lastError.slice(0, 500)}
        </Text>
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap", marginTop: 2 }}>
          <Button variant="default" size="sm" onPress={handleInstall}>
            <Text style={{ color: "#fff", fontSize: 12 }}>Retry</Text>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onPress={() => {
              setLastError(null);
              handleSkip();
            }}
          >
            <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>Dismiss</Text>
          </Button>
        </View>
      </View>
    );
  }

  // Post-install "Indexing your project…" mode. Shows % progress sourced
  // from the server's calibrated estimate.
  if (showPostInstallProgress && activeIndex) {
    const pct = Math.round(activeIndex.indexing?.status.progress ?? 0);
    const workspaceLabel = labelForWorkspace(activeIndex.workspaceId);
    return (
      <View style={compactPillStyle(theme)}>
        <View style={compactHeaderRow}>
          <Text numberOfLines={1} style={compactHeaderText(theme)}>
            Indexing {workspaceLabel}
          </Text>
          <Text style={compactElapsedText(theme)}>{pct}%</Text>
        </View>
        <DeterminateBar pct={pct} />
        <Text style={compactStageText(theme)} numberOfLines={1}>
          Building graph and embeddings…
        </Text>
      </View>
    );
  }

  // Compact "installing" mode — small pill with an indeterminate bar + stage
  // label + elapsed counter. No marketing copy, no log dump: progress is the
  // whole point. User knows what they clicked; keep it out of their face.
  if (installing) {
    const elapsed = startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0;
    return (
      <View
        style={{
          position: "absolute",
          bottom: 16,
          right: 16,
          width: 320,
          padding: 10,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.surface1,
          shadowColor: "#000",
          shadowOpacity: 0.3,
          shadowRadius: 12,
          shadowOffset: { width: 0, height: 6 },
          gap: 8,
          zIndex: 1000,
        }}
      >
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <Text
            numberOfLines={1}
            style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "600", flex: 1 }}
          >
            Installing code-review-graph
          </Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{elapsed}s</Text>
        </View>
        <IndeterminateBar />
        <Text
          numberOfLines={1}
          style={{ color: theme.colors.foregroundMuted, fontSize: 10, fontFamily: "monospace" }}
        >
          {installStage}
        </Text>
      </View>
    );
  }

  // Full "pitch" mode — shown before the user clicks Install.
  return (
    <View
      style={{
        position: "absolute",
        bottom: 16,
        right: 16,
        maxWidth: 420,
        padding: 16,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        shadowColor: "#000",
        shadowOpacity: 0.3,
        shadowRadius: 16,
        shadowOffset: { width: 0, height: 8 },
        gap: 10,
        zIndex: 1000,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Sparkles size={16} color={theme.colors.foreground} />
        <Text style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "600" }}>
          Enable smarter, cheaper code agents
        </Text>
      </View>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, lineHeight: 17 }}>
        Install <Text style={{ fontFamily: "monospace" }}>code-review-graph</Text> and Hubcode will
        auto-index every project you open. Agents answer architecture, dependency, and impact
        questions from a structural graph instead of reading each file — which{" "}
        <Text style={{ fontWeight: "600" }}>reduces your LLM token spend</Text> on your own API
        keys. Runs locally, no API key needed.
      </Text>
      <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
        <Button variant="default" size="sm" onPress={handleInstall}>
          <Text style={{ color: "#fff", fontSize: 12 }}>Install now</Text>
        </Button>
        <Button variant="ghost" size="sm" onPress={handleSkip}>
          <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>Not now</Text>
        </Button>
        <Pressable onPress={handleDismissForever} hitSlop={6}>
          <Text
            style={{
              color: theme.colors.foregroundMuted,
              fontSize: 11,
              textDecorationLine: "underline",
              marginTop: 6,
            }}
          >
            Don't show again
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function DeterminateBar({ pct }: { pct: number }) {
  const { theme } = useUnistyles();
  const clamped = Math.max(0, Math.min(100, pct));
  return (
    <View
      style={{
        height: 3,
        borderRadius: 2,
        backgroundColor: theme.colors.surface2,
        overflow: "hidden",
      }}
    >
      <View
        style={{
          width: `${clamped}%`,
          height: "100%",
          borderRadius: 2,
          backgroundColor: theme.colors.foreground,
        }}
      />
    </View>
  );
}

// Shared styles between compact install + indexing pills. Keeps the two
// branches visually identical (height, padding, font sizes) so the morph
// from "Installing" to "Indexing" feels continuous, not like two popups.
const compactHeaderRow = {
  flexDirection: "row" as const,
  alignItems: "center" as const,
  justifyContent: "space-between" as const,
  gap: 8,
};
function compactPillStyle(theme: ReturnType<typeof useUnistyles>["theme"]) {
  return {
    position: "absolute" as const,
    bottom: 16,
    right: 16,
    width: 320,
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    gap: 8,
    zIndex: 1000,
  };
}
function compactHeaderText(theme: ReturnType<typeof useUnistyles>["theme"]) {
  return {
    color: theme.colors.foreground,
    fontSize: 12,
    fontWeight: "600" as const,
    flex: 1,
  };
}
function compactElapsedText(theme: ReturnType<typeof useUnistyles>["theme"]) {
  return { color: theme.colors.foregroundMuted, fontSize: 11 };
}
function compactStageText(theme: ReturnType<typeof useUnistyles>["theme"]) {
  return {
    color: theme.colors.foregroundMuted,
    fontSize: 10,
    fontFamily: "monospace" as const,
  };
}
function labelForWorkspace(workspaceId: string): string {
  // Last path segment; fall back to whole id if there's no slash.
  const idx = workspaceId.lastIndexOf("/");
  return idx >= 0 ? workspaceId.slice(idx + 1) : workspaceId;
}

/** Indeterminate progress bar — a 30% shimmer slides left-to-right. */
function IndeterminateBar() {
  const { theme } = useUnistyles();
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(anim, {
        toValue: 1,
        duration: 1200,
        easing: Easing.inOut(Easing.ease),
        // Native driver is not implemented on RN web / Electron — forcing
        // `true` there prints "RCTAnimation module is missing" on every
        // mount. Gate so native keeps the perf benefit.
        useNativeDriver: !isWeb,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [anim]);
  const translate = anim.interpolate({ inputRange: [0, 1], outputRange: ["-30%", "100%"] });
  return (
    <View
      style={{
        height: 3,
        borderRadius: 2,
        backgroundColor: theme.colors.surface2,
        overflow: "hidden",
      }}
    >
      <Animated.View
        style={{
          width: "30%",
          height: "100%",
          borderRadius: 2,
          backgroundColor: theme.colors.foreground,
          transform: [{ translateX: translate as unknown as number }],
        }}
      />
    </View>
  );
}
