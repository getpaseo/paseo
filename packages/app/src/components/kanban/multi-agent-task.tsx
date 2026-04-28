// MultiAgentTask — adapted from emdash for React Native
// Manages multiple agent variants with tabbed interface
import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { View, Text, Pressable, TextInput, ScrollView, ActivityIndicator } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import { CornerDownLeft } from "lucide-react-native";
import type { KanbanTask } from "@/types/kanban";
import { type Agent, AGENT_CONFIG } from "./agent-selector";
import { TaskScopeProvider } from "./task-scope-context";

interface Variant {
  id: string;
  agent: Agent;
  name: string;
  branch: string;
  path: string;
  worktreeId: string;
}

interface MultiAgentTaskProps {
  task: KanbanTask;
  projectPath?: string | null;
  defaultBranch?: string | null;
  onTaskInterfaceReady?: () => void;
}

export function MultiAgentTask({
  task,
  projectPath,
  defaultBranch,
  onTaskInterfaceReady,
}: MultiAgentTaskProps) {
  const { theme } = useUnistyles();
  const [prompt, setPrompt] = useState("");
  const [activeTabIndex, setActiveTabIndex] = useState(0);
  const [variantBusy, setVariantBusy] = useState<Record<string, boolean>>({});

  const multi = task.metadata?.multiAgent;
  const variants = (multi?.variants || []) as Variant[];

  const activeVariantPath = variants[activeTabIndex]?.path ?? task.path;

  const readySignaledRef = useRef<string | null>(null);
  useEffect(() => {
    if (!onTaskInterfaceReady) return;
    if (variants.length === 0) return;
    if (readySignaledRef.current === task.id) return;
    readySignaledRef.current = task.id;
    onTaskInterfaceReady();
  }, [task.id, variants.length, onTaskInterfaceReady]);

  const getVariantDisplayLabel = useCallback(
    (variant: Variant): string => {
      const config = AGENT_CONFIG[variant.agent];
      const baseName = config?.label || variant.agent;
      const agentVariants = variants.filter((v) => v.agent === variant.agent);
      if (agentVariants.length === 1) return baseName;
      const match = variant.name.match(/-(\d+)$/);
      const instanceNum = match ? match[1] : String(agentVariants.indexOf(variant) + 1);
      return `${baseName} #${instanceNum}`;
    },
    [variants],
  );

  // Build initial issue context from task metadata
  const initialInjection: string | null = useMemo(() => {
    const md = task.metadata;
    if (!md) return null;
    const p = (md.initialPrompt || "").trim();
    if (p) return p;

    // Linear
    const issue = md.linearIssue;
    if (issue) {
      const parts: string[] = [
        `Linked Linear issue: ${issue.identifier}${issue.title ? ` — ${issue.title}` : ""}`,
      ];
      const details: string[] = [];
      if (issue.state?.name) details.push(`State: ${issue.state.name}`);
      if (issue.assignee?.name) details.push(`Assignee: ${issue.assignee.name}`);
      if (issue.team?.name) details.push(`Team: ${issue.team.name}`);
      if (issue.project?.name) details.push(`Project: ${issue.project.name}`);
      if (details.length) parts.push(`Details: ${details.join(" • ")}`);
      if (issue.url) parts.push(`URL: ${issue.url}`);
      return parts.join("\n");
    }

    // GitHub
    const gh = md.githubIssue;
    if (gh) {
      const parts: string[] = [
        `Linked GitHub issue: #${gh.number}${gh.title ? ` — ${gh.title}` : ""}`,
      ];
      const details: string[] = [];
      if (gh.state) details.push(`State: ${gh.state}`);
      if (gh.url) parts.push(`URL: ${gh.url}`);
      if (details.length) parts.push(`Details: ${details.join(" • ")}`);
      return parts.join("\n");
    }

    // Jira
    const j = md.jiraIssue;
    if (j) {
      const parts: string[] = [`Linked Jira issue: ${j.key}${j.title ? ` — ${j.title}` : ""}`];
      const details: string[] = [];
      if (j.status?.name) details.push(`Status: ${j.status.name}`);
      if (j.assignee?.name) details.push(`Assignee: ${j.assignee.name}`);
      if (j.projectKey) details.push(`Project: ${j.projectKey}`);
      if (details.length) parts.push(`Details: ${details.join(" • ")}`);
      if (j.url) parts.push(`URL: ${j.url}`);
      return parts.join("\n");
    }

    return null;
  }, [task.metadata]);

  // Prefill prompt with issue context once
  const prefillOnceRef = useRef(false);
  useEffect(() => {
    if (prefillOnceRef.current) return;
    const text = (initialInjection || "").trim();
    if (text && !prompt) setPrompt(text);
    prefillOnceRef.current = true;
  }, [initialInjection]);

  const handleRunAll = useCallback(async () => {
    const msg = prompt.trim();
    if (!msg) return;
    // TODO: Send prompt to all agent variants via WebSocket
    // Each variant gets the same prompt injected into its session
    setPrompt("");
  }, [prompt]);

  if (!multi?.enabled) {
    return (
      <View style={styles.emptyContainer}>
        <Text style={styles.emptyText}>Multi-agent config missing for this task.</Text>
      </View>
    );
  }

  if (variants.length === 0) {
    return <View style={styles.emptyContainer} />;
  }

  return (
    <TaskScopeProvider
      value={{
        taskId: task.id,
        taskPath: activeVariantPath,
        projectPath: projectPath ?? undefined,
      }}
    >
      <View style={styles.container}>
        {/* Variant tabs */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.tabBar}
          contentContainerStyle={styles.tabBarContent}
        >
          {variants.map((variant, idx) => {
            const isActive = idx === activeTabIndex;
            const isBusy = variantBusy[variant.worktreeId] ?? false;
            return (
              <Pressable
                key={variant.worktreeId}
                onPress={() => setActiveTabIndex(idx)}
                style={[styles.tab, isActive && styles.tabActive]}
              >
                <Text style={[styles.tabText, isActive && styles.tabTextActive]}>
                  {getVariantDisplayLabel(variant)}
                </Text>
                {isBusy ? (
                  <ActivityIndicator
                    size="small"
                    color={isActive ? theme.colors.foreground : theme.colors.foregroundMuted}
                  />
                ) : null}
              </Pressable>
            );
          })}
        </ScrollView>

        {/* Active variant content */}
        <View style={styles.content}>
          {variants.map((v, idx) => {
            if (idx !== activeTabIndex) return null;
            return (
              <View key={v.worktreeId} style={styles.variantPane}>
                <View style={styles.variantInfo}>
                  <Text style={styles.variantName}>{v.name}</Text>
                  {v.branch ? <Text style={styles.variantBranch}>{v.branch}</Text> : null}
                </View>
                {/* TODO: Render session/terminal view for this variant via WebSocket */}
                <View style={styles.terminalPlaceholder}>
                  <Text style={styles.placeholderText}>
                    Session for {AGENT_CONFIG[v.agent]?.label || v.agent}
                  </Text>
                  <Text style={styles.placeholderSubtext}>
                    Variant: {v.name} ({v.path})
                  </Text>
                </View>
              </View>
            );
          })}
        </View>

        {/* Prompt input bar */}
        <View style={styles.promptBar}>
          <TextInput
            style={styles.promptInput}
            value={prompt}
            onChangeText={setPrompt}
            placeholder="Tell the agents what to do..."
            placeholderTextColor={theme.colors.foregroundMuted}
            multiline={false}
            returnKeyType="send"
            onSubmitEditing={() => {
              if (prompt.trim()) void handleRunAll();
            }}
          />
          <Pressable
            onPress={() => {
              if (prompt.trim()) void handleRunAll();
            }}
            style={[styles.sendBtn, !prompt.trim() && styles.sendBtnDisabled]}
            disabled={!prompt.trim()}
          >
            <CornerDownLeft
              size={16}
              color={prompt.trim() ? theme.colors.foreground : theme.colors.foregroundMuted}
            />
          </Pressable>
        </View>
      </View>
    </TaskScopeProvider>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: { flex: 1 },
  emptyContainer: { flex: 1, justifyContent: "center", alignItems: "center" },
  emptyText: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted },
  tabBar: { flexGrow: 0 },
  tabBarContent: {
    flexDirection: "row",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  tab: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.surface2,
    backgroundColor: "transparent",
  },
  tabActive: {
    borderWidth: 2,
    borderColor: theme.colors.foreground,
    backgroundColor: theme.colors.surface1,
  },
  tabText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  tabTextActive: { color: theme.colors.foreground },
  content: { flex: 1 },
  variantPane: { flex: 1, padding: theme.spacing[3], gap: theme.spacing[2] },
  variantInfo: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  variantName: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
  },
  variantBranch: { fontSize: theme.fontSize.xs, color: theme.colors.foregroundMuted },
  terminalPlaceholder: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing[4],
  },
  placeholderText: { fontSize: theme.fontSize.sm, color: theme.colors.foreground },
  placeholderSubtext: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    marginTop: theme.spacing[1],
  },
  promptBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.surface2,
  },
  promptInput: {
    flex: 1,
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  sendBtn: {
    padding: theme.spacing[2],
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.md,
  },
  sendBtnDisabled: { opacity: 0.5 },
}));
