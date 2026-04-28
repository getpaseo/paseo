// Integration context display for kanban cards
// Shows linked integration issues with icons and titles

import { useEffect, useMemo, useState } from "react";
import { View, Text, Pressable } from "react-native";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import Svg, { Path } from "react-native-svg";
import { ExternalLink, Bug, MessageSquare, AlertTriangle, X } from "lucide-react-native";
import { openExternalUrl } from "@/utils/open-external-url";
import type { IntegrationId, TaskIntegrationContext } from "@/types/kanban";
import type { TaskMetadata } from "@/types/integrations";
import { useIntegrationSearch } from "@/hooks/use-integration-status";

// ─── Integration icon SVGs ──────────────────────────────────────────

interface IconProps {
  size?: number;
  color?: string;
}

function LinearIcon({ size = 14, color = "currentColor" }: IconProps) {
  // Simple geometric mark inspired by Linear's diagonal arrow shape
  return (
    <Svg width={size} height={size} viewBox="0 0 14 14" fill="none">
      <Path d="M0 9L5 14L14 5L9 0L0 9Z" fill={color} />
      <Path d="M0 11.5L2.5 14L14 2.5L11.5 0L0 11.5Z" fill={color} opacity={0.3} />
    </Svg>
  );
}

// Simple placeholder icons for integrations without custom SVGs
function JiraIcon({ size = 14, color = "currentColor" }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path
        d="M11.53 2c0 5.253 4.243 9.496 9.497 9.496H22v.957a9.495 9.495 0 01-9.496 9.496h-.958A9.495 9.495 0 012 12.453v-.957A9.495 9.495 0 0111.496 2h.034z"
        fill={color}
      />
    </Svg>
  );
}

function GitLabIcon({ size = 14, color = "currentColor" }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
      <Path d="m12 21.35-7.05-5.423a.729.729 0 0 1-.263-.665l.957-7.307L8.37 2.523a.372.372 0 0 1 .706 0l2.075 5.432h1.698l2.075-5.432a.372.372 0 0 1 .706 0l2.726 5.432.957 7.307a.729.729 0 0 1-.263.665L12 21.35Z" />
    </Svg>
  );
}

function SentryIcon({ size = 14, color = "currentColor" }: IconProps) {
  return <AlertTriangle size={size} color={color} />;
}

function ForgejoIcon({ size = 14, color = "currentColor" }: IconProps) {
  return <Bug size={size} color={color} />;
}

function PlainIcon({ size = 14, color = "currentColor" }: IconProps) {
  return <MessageSquare size={size} color={color} />;
}

function GithubIcon({ size = 14, color = "currentColor" }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
      <Path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </Svg>
  );
}

// ─── Public exports ─────────────────────────────────────────────────

export function integrationDisplayName(id: IntegrationId): string {
  switch (id) {
    case "linear":
      return "Linear";
    case "github":
      return "GitHub";
    case "jira":
      return "Jira";
    case "gitlab":
      return "GitLab";
    case "sentry":
      return "Sentry";
    case "forgejo":
      return "Forgejo";
    case "plain":
      return "Plain";
    default:
      return id;
  }
}

export function IntegrationIcon({
  integration,
  size = 14,
  color,
}: {
  integration: IntegrationId;
  size?: number;
  color?: string;
}) {
  switch (integration) {
    case "linear":
      return <LinearIcon size={size} color={color} />;
    case "github":
      return <GithubIcon size={size} color={color} />;
    case "jira":
      return <JiraIcon size={size} color={color} />;
    case "gitlab":
      return <GitLabIcon size={size} color={color} />;
    case "sentry":
      return <SentryIcon size={size} color={color} />;
    case "forgejo":
      return <ForgejoIcon size={size} color={color} />;
    case "plain":
      return <PlainIcon size={size} color={color} />;
    default:
      return null;
  }
}

export interface LinkedIntegration {
  id: IntegrationId;
  identifier: string;
  title: string;
  url?: string | null;
  description?: string | null;
  /** Extra metadata lines like status, assignee, project */
  meta: string[];
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function toStringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toNumberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function identifierFromRaw(id: IntegrationId, raw: Record<string, unknown>): string | undefined {
  switch (id) {
    case "linear":
      return toStringValue(raw.identifier) ?? toStringValue(raw.id);
    case "github": {
      const n = toNumberValue(raw.number);
      return n != null ? `#${n}` : (toStringValue(raw.identifier) ?? toStringValue(raw.id));
    }
    case "jira":
      return toStringValue(raw.key) ?? toStringValue(raw.identifier) ?? toStringValue(raw.id);
    case "gitlab": {
      const iid = toNumberValue(raw.iid);
      return iid != null ? `#${iid}` : (toStringValue(raw.identifier) ?? toStringValue(raw.id));
    }
    case "forgejo": {
      const n = toNumberValue(raw.number);
      return n != null ? `#${n}` : (toStringValue(raw.identifier) ?? toStringValue(raw.id));
    }
    case "plain":
      return (
        toStringValue(raw.externalId) ?? toStringValue(raw.id) ?? toStringValue(raw.identifier)
      );
    case "sentry":
      return toStringValue(raw.id) ?? toStringValue(raw.identifier);
    default:
      return toStringValue(raw.identifier) ?? toStringValue(raw.id);
  }
}

export function mergeLinkedIntegrationWithRawIssue(
  base: LinkedIntegration,
  raw: Record<string, unknown>,
): LinkedIntegration {
  const meta = [...base.meta];
  const pushMeta = (value: string | undefined) => {
    if (value && !meta.includes(value)) {
      meta.push(value);
    }
  };

  let url = base.url ?? null;
  let description = base.description ?? null;
  let title = base.title;

  switch (base.id) {
    case "linear":
      url = toStringValue(raw.url) ?? url;
      description = toStringValue(raw.description) ?? description;
      title = toStringValue(raw.title) ?? title;
      pushMeta(toStringValue(toRecord(raw.state)?.name));
      pushMeta(toStringValue(toRecord(raw.assignee)?.name));
      pushMeta(toStringValue(toRecord(raw.project)?.name));
      pushMeta(toStringValue(toRecord(raw.team)?.name));
      break;
    case "github":
      url = toStringValue(raw.url) ?? url;
      description = toStringValue(raw.body) ?? description;
      title = toStringValue(raw.title) ?? title;
      pushMeta(toStringValue(raw.state));
      pushMeta(toStringValue(raw.repository));
      break;
    case "jira":
      url = toStringValue(raw.url) ?? url;
      description = toStringValue(raw.description) ?? description;
      title = toStringValue(raw.title) ?? title;
      pushMeta(toStringValue(toRecord(raw.status)?.name));
      pushMeta(toStringValue(toRecord(raw.assignee)?.name));
      pushMeta(toStringValue(toRecord(raw.priority)?.name));
      break;
    case "gitlab":
      url = toStringValue(raw.webUrl) ?? url;
      description = toStringValue(raw.description) ?? description;
      title = toStringValue(raw.title) ?? title;
      pushMeta(toStringValue(raw.state));
      pushMeta(toStringValue(raw.projectPath));
      break;
    case "forgejo":
      url = toStringValue(raw.htmlUrl) ?? url;
      description = toStringValue(raw.body) ?? description;
      title = toStringValue(raw.title) ?? title;
      pushMeta(toStringValue(raw.state));
      pushMeta(toStringValue(toRecord(raw.repository)?.fullName));
      break;
    case "plain":
      description = toStringValue(raw.previewText) ?? description;
      title = toStringValue(raw.title) ?? title;
      pushMeta(toStringValue(raw.status));
      pushMeta(toStringValue(toRecord(raw.customer)?.fullName));
      break;
    case "sentry":
      url = toStringValue(raw.permalink) ?? url;
      description = toStringValue(raw.culprit) ?? description;
      title = toStringValue(raw.title) ?? title;
      pushMeta(toStringValue(raw.level));
      pushMeta(toStringValue(raw.culprit));
      break;
  }

  return {
    ...base,
    identifier: identifierFromRaw(base.id, raw) ?? base.identifier,
    title,
    url,
    description,
    meta,
  };
}

function getPromptIssueBlock(
  prompt: string,
  input: { id: IntegrationId; identifier: string },
): string | null {
  const normalizedPrompt = prompt.trim();
  if (!normalizedPrompt) {
    return null;
  }
  const blocks = normalizedPrompt
    .split(/\n\s*---\s*\n/g)
    .map((part) => part.trim())
    .filter(Boolean);
  const providerName = integrationDisplayName(input.id).toLowerCase();
  const identifier = input.identifier.trim().toLowerCase();
  const identifierNoHash = identifier.replace(/^#/, "");

  for (const block of blocks) {
    const blockLower = block.toLowerCase();
    const hasProvider =
      blockLower.includes(`linked ${providerName}`) || blockLower.includes(providerName);
    const hasIdentifier =
      blockLower.includes(identifier) ||
      (identifierNoHash.length > 0 && blockLower.includes(identifierNoHash));
    if (hasProvider && hasIdentifier) {
      return block;
    }
  }

  return null;
}

function enrichFromPrompt(item: LinkedIntegration, prompt: string | undefined): LinkedIntegration {
  const rawPrompt = prompt?.trim();
  if (!rawPrompt) {
    return item;
  }
  const block = getPromptIssueBlock(rawPrompt, { id: item.id, identifier: item.identifier });
  if (!block) {
    return item;
  }

  const firstLine = block.split("\n")[0]?.trim() ?? "";
  const titleFromFirstLine = (() => {
    // Prompt format is `<label> — <identifier> — <title>`. Take the slice
    // after the *last* em-dash so the title doesn't accidentally include
    // the identifier prefix.
    const emDashIdx = firstLine.lastIndexOf("—");
    if (emDashIdx >= 0) {
      const value = firstLine.slice(emDashIdx + 1).trim();
      return value.length > 0 ? value : null;
    }
    const hyphenIdx = firstLine.lastIndexOf(" - ");
    if (hyphenIdx >= 0) {
      const value = firstLine.slice(hyphenIdx + 3).trim();
      return value.length > 0 ? value : null;
    }
    return null;
  })();

  // Prefer values already on the item (e.g. from metadata). Fall back to the
  // prompt-extracted ones only when the item field is empty — metadata is
  // authoritative.
  const urlMatch = block.match(/URL:\s*(https?:\/\/\S+)/i);
  const url = item.url ?? urlMatch?.[1] ?? null;

  const descriptionMatch = block.match(/Issue Description:\s*([\s\S]*)$/i);
  const extractedDescription = descriptionMatch?.[1]?.trim() ?? "";
  const description = item.description || extractedDescription || null;

  return {
    ...item,
    title: titleFromFirstLine ?? item.title,
    url,
    description,
  };
}

function inferFromTaskName(taskName: string | undefined): LinkedIntegration | null {
  const raw = taskName?.trim().toLowerCase();
  if (!raw) return null;

  const parts = raw.split("-").filter(Boolean);
  if (parts.length < 2) return null;

  const id = parts[0] as IntegrationId;
  if (!["linear", "github", "jira", "gitlab", "plain", "forgejo", "sentry"].includes(id)) {
    return null;
  }

  let identifier = parts[1] ?? "";
  let titleStartIndex = 2;
  if ((id === "linear" || id === "jira") && parts.length >= 3 && /^\d+$/.test(parts[2] ?? "")) {
    identifier = `${parts[1]}-${parts[2]}`;
    titleStartIndex = 3;
  }
  if (!identifier) {
    return null;
  }

  const normalizedIdentifier =
    id === "github" || id === "gitlab" || id === "forgejo"
      ? identifier.startsWith("#")
        ? identifier
        : `#${identifier}`
      : identifier.toUpperCase();

  // Extract human-readable title from the remaining slug parts (e.g. "get-familiar-with-x" → "get familiar with x")
  const titleParts = parts.slice(titleStartIndex);
  const title =
    titleParts.length > 0 ? titleParts.join(" ") : `Linked ${integrationDisplayName(id)} item`;

  return {
    id,
    identifier: normalizedIdentifier,
    title,
    url: null,
    description: null,
    meta: [],
  };
}

function trimIntegrationRef(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function extractLinkedIntegrations(
  metadata?: TaskMetadata,
  integrations?: TaskIntegrationContext,
  taskName?: string,
  taskPrompt?: string,
): LinkedIntegration[] {
  const result: LinkedIntegration[] = [];

  if (metadata?.linearIssue) {
    const i = metadata.linearIssue;
    const meta: string[] = [];
    if (i.state?.name) meta.push(i.state.name);
    if (i.assignee?.name) meta.push(i.assignee.name);
    if (i.project?.name) meta.push(i.project.name);
    if (i.team?.name) meta.push(i.team.name);
    result.push({
      id: "linear",
      identifier: i.identifier,
      title: i.title,
      url: i.url,
      description: i.description,
      meta,
    });
  }

  if (metadata?.githubIssue) {
    const i = metadata.githubIssue;
    const meta: string[] = [];
    if (i.state) meta.push(i.state);
    if (i.repository) meta.push(i.repository);
    result.push({
      id: "github",
      identifier: `#${i.number}`,
      title: i.title,
      url: i.url,
      description: i.body,
      meta,
    });
  }

  if (metadata?.jiraIssue) {
    const i = metadata.jiraIssue;
    const meta: string[] = [];
    if (i.status?.name) meta.push(i.status.name);
    if (i.assignee?.name) meta.push(i.assignee.name);
    if (i.priority?.name) meta.push(i.priority.name);
    result.push({
      id: "jira",
      identifier: i.key,
      title: i.title,
      url: i.url,
      description: i.description,
      meta,
    });
  }

  if (metadata?.gitlabIssue) {
    const i = metadata.gitlabIssue;
    const meta: string[] = [];
    if (i.state) meta.push(i.state);
    if (i.projectPath) meta.push(i.projectPath);
    result.push({
      id: "gitlab",
      identifier: `#${i.iid}`,
      title: i.title,
      url: i.webUrl,
      description: i.description,
      meta,
    });
  }

  if (metadata?.plainThread) {
    const i = metadata.plainThread;
    const meta: string[] = [];
    if (i.status) meta.push(i.status);
    if (i.customer?.fullName) meta.push(i.customer.fullName);
    result.push({
      id: "plain",
      identifier: i.externalId ?? i.id,
      title: i.title,
      url: null,
      description: i.previewText,
      meta,
    });
  }

  if (metadata?.forgejoIssue) {
    const i = metadata.forgejoIssue;
    const meta: string[] = [];
    if (i.state) meta.push(i.state);
    if (i.repository?.fullName) meta.push(i.repository.fullName);
    result.push({
      id: "forgejo",
      identifier: `#${i.number}`,
      title: i.title,
      url: i.htmlUrl,
      description: i.body,
      meta,
    });
  }

  if (metadata?.sentryIssue) {
    const i = metadata.sentryIssue;
    const meta: string[] = [];
    if (i.level) meta.push(i.level);
    if (i.culprit) meta.push(i.culprit);
    result.push({
      id: "sentry",
      identifier: `SENTRY-${i.id}`,
      title: i.title,
      url: i.permalink,
      description: i.culprit,
      meta,
    });
  }

  if (integrations) {
    const existingIds = new Set(result.map((item) => item.id));
    const fallbackById: Array<{ id: IntegrationId; ref: string | undefined }> = [
      { id: "linear", ref: integrations.linearIssueId },
      { id: "github", ref: integrations.githubIssueId },
      { id: "jira", ref: integrations.jiraIssueId },
      { id: "gitlab", ref: integrations.gitlabIssueId },
      { id: "plain", ref: integrations.plainThreadId },
      { id: "forgejo", ref: integrations.forgejoIssueId },
      { id: "sentry", ref: integrations.sentryIssueId },
    ];

    for (const entry of fallbackById) {
      if (existingIds.has(entry.id)) {
        continue;
      }
      const identifier = trimIntegrationRef(entry.ref);
      if (!identifier) {
        continue;
      }
      const displayName = integrationDisplayName(entry.id);
      result.push({
        id: entry.id,
        identifier,
        title: `Linked ${displayName} item`,
        url: null,
        description: null,
        meta: [],
      });
      existingIds.add(entry.id);
    }
  }

  if (result.length === 0) {
    const inferred = inferFromTaskName(taskName);
    if (inferred) {
      result.push(inferred);
    }
  }

  return result.map((item) => enrichFromPrompt(item, taskPrompt));
}

// ─── Integration detail card (shown on info press) ──────────────────

interface IntegrationDetailProps {
  item: LinkedIntegration;
  onClose: () => void;
  serverId?: string;
  cwd?: string;
}

export function IntegrationDetail({ item, onClose, serverId, cwd }: IntegrationDetailProps) {
  const { theme } = useUnistyles();
  const searchMutation = useIntegrationSearch(serverId);
  const [resolvedItem, setResolvedItem] = useState(item);

  useEffect(() => {
    setResolvedItem(item);
  }, [item]);

  const canHydrate = useMemo(
    () => Boolean(serverId) && (!resolvedItem.url || !resolvedItem.description),
    [resolvedItem.description, resolvedItem.url, serverId],
  );

  useEffect(() => {
    if (!canHydrate || !serverId) {
      return;
    }

    let cancelled = false;
    const query = resolvedItem.identifier.replace(/^#/, "").trim() || resolvedItem.title.trim();
    if (!query) {
      return;
    }

    void searchMutation
      .mutateAsync({
        integrationId: resolvedItem.id,
        query,
        cwd: cwd?.trim() || undefined,
        limit: 5,
      })
      .then((result) => {
        if (cancelled || !result.items?.length) {
          return;
        }
        const raw = result.items[0];
        if (!raw || typeof raw !== "object") {
          return;
        }
        setResolvedItem((prev) => mergeLinkedIntegrationWithRawIssue(prev, raw));
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- searchMutation is a new object each render; including it causes infinite loops
  }, [canHydrate, cwd, resolvedItem.id, resolvedItem.identifier, resolvedItem.title, serverId]);

  return (
    <View style={detailStyles.card}>
      <View style={detailStyles.header}>
        <View style={detailStyles.headerLeft}>
          <IntegrationIcon
            integration={resolvedItem.id}
            size={14}
            color={theme.colors.foreground}
          />
          <Text style={detailStyles.identifier}>{resolvedItem.identifier}</Text>
        </View>
        <View style={detailStyles.headerRight}>
          {resolvedItem.url ? (
            <Pressable
              style={({ pressed }) => [
                detailStyles.openButton,
                pressed && detailStyles.openButtonPressed,
              ]}
              onPress={() => resolvedItem.url && void openExternalUrl(resolvedItem.url)}
              hitSlop={8}
            >
              <ExternalLink size={11} color={theme.colors.foreground} />
              <Text style={detailStyles.openButtonText}>
                Open in {integrationDisplayName(resolvedItem.id)}
              </Text>
            </Pressable>
          ) : null}
          <Pressable onPress={onClose} hitSlop={8}>
            <X size={12} color={theme.colors.foregroundMuted} />
          </Pressable>
        </View>
      </View>
      <Text style={detailStyles.title} numberOfLines={2}>
        {resolvedItem.title}
      </Text>
      {resolvedItem.description ? (
        <Text style={detailStyles.description} numberOfLines={3}>
          {resolvedItem.description}
        </Text>
      ) : null}
      {resolvedItem.meta.length > 0 ? (
        <Text style={detailStyles.meta} numberOfLines={1}>
          {resolvedItem.meta.join(" \u00B7 ")}
        </Text>
      ) : null}
    </View>
  );
}

const detailStyles = StyleSheet.create((theme) => ({
  card: {
    backgroundColor: theme.colors.surface0,
    borderRadius: theme.borderRadius.md,
    borderWidth: 1,
    borderColor: theme.colors.surface2,
    padding: theme.spacing[2],
    gap: theme.spacing[1],
    marginTop: theme.spacing[1],
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  identifier: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.semibold,
    color: theme.colors.foregroundMuted,
  },
  title: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  description: {
    fontSize: 11,
    color: theme.colors.foregroundMuted,
    lineHeight: 15,
  },
  meta: {
    fontSize: 10,
    color: theme.colors.foregroundMuted,
  },
  openButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    backgroundColor: theme.colors.surface2,
    borderRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 3,
  },
  openButtonPressed: {
    opacity: 0.7,
  },
  openButtonText: {
    fontSize: 10,
    color: theme.colors.foreground,
    fontWeight: theme.fontWeight.medium,
  },
}));
