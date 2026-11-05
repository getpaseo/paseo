// The plugin the demo agent "builds" in the store screenshots: a Deploys pill on
// every composer that opens the latest preview deploy for each branch. The
// deploys are fixed sample data; the UI is a real plugin surface.
import type {
  PluginButtonContentProps,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { Text, View } from "react-native";

type DeployStatus = "ready" | "building" | "failed";

interface Deploy {
  branch: string;
  status: DeployStatus;
  detail: string;
  age: string;
  progress?: number;
}

const DEPLOYS: Deploy[] = [
  { branch: "fix/reconnect-jitter", status: "ready", detail: "Built in 48s", age: "2m" },
  {
    branch: "perf/provider-snapshot-cache",
    status: "building",
    detail: "Bundling app",
    age: "now",
    progress: 0.64,
  },
  { branch: "feat/remember-terminal", status: "ready", detail: "Built in 51s", age: "18m" },
  {
    branch: "i18n/ko-settings",
    status: "failed",
    detail: "Missing key settings.notifications",
    age: "26m",
  },
];

function DeploysSheet({ theme, layout }: PluginButtonContentProps) {
  const mono = layout.platform === "ios" ? "Menlo" : "monospace";
  const styles = useMemo(
    () => ({
      // Popovers on tablets and desktop are narrow by default; give the
      // branch names room. Phones show the sheet at full width.
      body: { gap: 14, width: layout.compact ? undefined : 400 },
      production: {
        padding: 14,
        gap: 6,
        borderRadius: 12,
        backgroundColor: theme.colors.surface2,
      },
      productionTop: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
      label: { color: theme.colors.foregroundMuted, fontSize: 13 },
      version: { color: theme.colors.foreground, fontSize: 22, fontWeight: "600" as const },
      live: { color: theme.colors.statusSuccess, fontSize: 13, fontWeight: "600" as const },
      heading: { color: theme.colors.foregroundMuted, fontSize: 13, marginTop: 4 },
      list: {
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.border,
        overflow: "hidden" as const,
      },
      row: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 12,
        paddingVertical: 12,
        paddingHorizontal: 14,
      },
      divider: { height: 1, backgroundColor: theme.colors.border },
      text: { flex: 1, gap: 4 },
      branch: { color: theme.colors.foreground, fontSize: 14, fontFamily: mono },
      detail: { color: theme.colors.foregroundMuted, fontSize: 13 },
      failed: { color: theme.colors.statusDanger, fontSize: 13 },
      age: { color: theme.colors.foregroundMuted, fontSize: 13 },
      track: {
        height: 4,
        marginTop: 4,
        borderRadius: 2,
        backgroundColor: theme.colors.surface2,
        overflow: "hidden" as const,
      },
    }),
    [theme, mono, layout.compact],
  );
  const dotColor: Record<DeployStatus, string> = {
    ready: theme.colors.statusSuccess,
    building: theme.colors.statusWarning,
    failed: theme.colors.statusDanger,
  };

  return (
    <View style={styles.body}>
      <View style={styles.production}>
        <View style={styles.productionTop}>
          <Dot color={theme.colors.statusSuccess} />
          <Text style={styles.live}>Live</Text>
          <Text style={styles.label}>Production · main</Text>
        </View>
        <Text style={styles.version}>v0.14.0-beta.1</Text>
        <Text style={styles.label}>Deployed 3h ago</Text>
      </View>
      <Text style={styles.heading}>Previews</Text>
      <View style={styles.list}>
        {DEPLOYS.map((deploy, index) => (
          <View key={deploy.branch}>
            {index > 0 ? <View style={styles.divider} /> : null}
            <View style={styles.row}>
              <Dot color={dotColor[deploy.status]} />
              <View style={styles.text}>
                <Text style={styles.branch} numberOfLines={1}>
                  {deploy.branch}
                </Text>
                <Text style={deploy.status === "failed" ? styles.failed : styles.detail}>
                  {deploy.detail}
                </Text>
                {deploy.progress !== undefined ? (
                  <Progress
                    value={deploy.progress}
                    track={styles.track}
                    color={theme.colors.statusWarning}
                  />
                ) : null}
              </View>
              <Text style={styles.age}>{deploy.age}</Text>
            </View>
          </View>
        ))}
      </View>
    </View>
  );
}

function Progress({ value, track, color }: { value: number; track: object; color: string }) {
  const fill = useMemo(
    () => ({ width: `${value * 100}%` as const, height: 4, backgroundColor: color }),
    [value, color],
  );
  return (
    <View style={track}>
      <View style={fill} />
    </View>
  );
}

function Dot({ color }: { color: string }) {
  const style = useMemo(
    () => ({ width: 8, height: 8, borderRadius: 4, backgroundColor: color }),
    [color],
  );
  return <View style={style} />;
}

export default function contribute(client: PluginClientContext) {
  const pills = new Map<string, PluginButtonRegistration>();
  const lifetime = new AbortController();
  const register = (agent: { id: string; workspaceId?: string | null }) => {
    if (lifetime.signal.aborted || !agent.workspaceId) return;
    pills.get(agent.id)?.remove();
    pills.set(
      agent.id,
      client.addComposerPill({
        id: "deploys",
        workspaceId: agent.workspaceId,
        agentId: agent.id,
        button: {
          title: "Preview deploys",
          icon: "Rocket",
          label: "Deploys",
          behavior: { kind: "popover", Content: DeploysSheet },
        },
      }),
    );
  };
  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => {
          for (const pill of pills.values()) pill.remove();
          pills.clear();
          for (const { agent } of entries) register(agent);
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "remove") {
            pills.get(update.agentId)?.remove();
            pills.delete(update.agentId);
          } else register(update.agent);
        },
      });
      return undefined;
    })
    .catch((error) => {
      if (!lifetime.signal.aborted) console.error("Agent observation failed", error);
    });
  return () => {
    lifetime.abort();
    for (const pill of pills.values()) pill.remove();
    pills.clear();
  };
}
