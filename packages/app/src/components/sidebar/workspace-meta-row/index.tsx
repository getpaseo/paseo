import { Fragment, useCallback, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View, type GestureResponderEvent } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  ExternalLink,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  Globe,
} from "lucide-react-native";
import type { HostBadgeModel } from "@/hosts/appearance";
import { HostBadge, HOST_BADGE_ICON_SIZE } from "@/hosts/host-badge";
import type { PrHint } from "@/git/pr-hint";
import { getForgePresentation, normalizeForge } from "@/git/forge";
import { openExternalUrl } from "@/utils/open-external-url";
import { useSidebarMetaPreferences } from "@/components/sidebar/display-preferences/model";
import type { Theme } from "@/styles/theme";
import { CheckIndicator } from "./check-indicator";
import type { CheckSummary, CheckSummaryState } from "./check-summary";
import { selectMetaRowItems, type MetaRowItem } from "./meta-items";
import { workspaceServiceLabelKey, type WorkspaceServiceSummary } from "./service-summary";

export {
  selectWorkspaceServiceSummary,
  workspaceServiceLabelKey,
  type WorkspaceServiceSummary,
} from "./service-summary";

/**
 * One size for every glyph on the line. The items are peers — host, change request, CI,
 * running service — so a glyph that differs in size reads as a different rank. The host badge
 * owns the size because it is the one item that also appears off this line.
 */
const META_ICON_SIZE = HOST_BADGE_ICON_SIZE;

const ThemedExternalLink = withUnistyles(ExternalLink);
const ThemedGitPullRequest = withUnistyles(GitPullRequest);
const ThemedGitMerge = withUnistyles(GitMerge);
const ThemedGitPullRequestClosed = withUnistyles(GitPullRequestClosed);
const ThemedGlobe = withUnistyles(Globe);

const foregroundMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const mergedMapping = (theme: Theme) => ({ color: theme.colors.statusMerged });
const dangerMapping = (theme: Theme) => ({ color: theme.colors.statusDanger });

/**
 * The subtitle under a workspace title: which host it lives on, its change request, that
 * change request's CI, and any running service. Everything the row knows about a workspace
 * that isn't its name.
 *
 * Items are peers separated by a dot rather than ranked by chrome. The host used to be a
 * tinted pill on the title line, which made it the loudest thing in a row whose subject is
 * the title; flattening it lets the whole line read as one piece of secondary text and
 * leaves color to mean status.
 */
export function WorkspaceMetaRow({
  hostBadge,
  projectSubtitle = null,
  prHint,
  serviceSummary,
}: {
  hostBadge: HostBadgeModel | null;
  /** When set (status grouping + project subtitle pref), replaces host identity. */
  projectSubtitle?: string | null;
  prHint: PrHint | null;
  serviceSummary: WorkspaceServiceSummary | null;
}) {
  const { rowItems, checksDisplay } = useSidebarMetaPreferences();
  const items = selectMetaRowItems({
    hasHostBadge: hostBadge !== null,
    projectSubtitle,
    prHint,
    serviceSummary,
    visible: rowItems,
    checksDisplay,
  });

  if (items.length === 0) return null;

  return (
    <View style={styles.row}>
      {items.map((item, index) => (
        <Fragment key={item.kind === "project" ? `project-${item.name}` : item.kind}>
          {index > 0 ? <Text style={styles.separator}>·</Text> : null}
          <MetaItemNode item={item} hostBadge={hostBadge} />
        </Fragment>
      ))}
    </View>
  );
}

function MetaItemNode({
  item,
  hostBadge,
}: {
  item: MetaRowItem;
  hostBadge: HostBadgeModel | null;
}): ReactNode {
  if (item.kind === "host") {
    return hostBadge ? <HostBadge badge={hostBadge} /> : null;
  }
  if (item.kind === "project") {
    return (
      <Text style={styles.projectName} numberOfLines={1}>
        {item.name}
      </Text>
    );
  }
  if (item.kind === "changeRequest") {
    return <PullRequestItem hint={item.hint} />;
  }
  if (item.kind === "checks") {
    return <ChecksItem summary={item.summary} label={item.label} />;
  }
  return <ServiceItem summary={item.summary} />;
}

/**
 * The only thing on the line that navigates, so it is the only thing that answers the
 * pointer: it brightens to full foreground and its icon becomes an external-link arrow,
 * saying where the click goes before you spend it.
 *
 * `onHoverIn`/`onHoverOut` with local state is safe here despite the usual rule in
 * docs/hover.md — the state never leaves this Pressable, and nothing pressable is nested
 * inside it, so there is no second hover state machine to fight. Both icons are the same
 * size, so the swap can't move the target out from under the cursor.
 */
function PullRequestItem({ hint }: { hint: PrHint }) {
  const { t } = useTranslation();
  const [isHovered, setIsHovered] = useState(false);
  const presentation = getForgePresentation(normalizeForge(hint.forge));

  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      void openExternalUrl(hint.url);
    },
    [hint.url],
  );
  const handlePressIn = useCallback((event: GestureResponderEvent) => event.stopPropagation(), []);
  const handleHoverIn = useCallback(() => setIsHovered(true), []);
  const handleHoverOut = useCallback(() => setIsHovered(false), []);

  const Icon = isHovered ? ThemedExternalLink : PR_ICONS[hint.state];
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={t("workspace.git.pr.accessibility.pullRequest", {
        number: hint.number,
        context: presentation.changeRequestContext,
      })}
      hitSlop={4}
      onPressIn={handlePressIn}
      onPress={handlePress}
      onHoverIn={handleHoverIn}
      onHoverOut={handleHoverOut}
      style={pressableItemStyle}
    >
      <Icon
        size={META_ICON_SIZE}
        uniProps={isHovered ? foregroundMapping : PR_COLOR_MAPPINGS[hint.state]}
      />
      <Text style={isHovered ? styles.prTextHovered : styles.prText} numberOfLines={1}>
        {hint.number}
        {/* An open change request is the unremarkable case and says nothing extra; a merged
            or closed one is why the row still looks like it has work in it. */}
        {hint.state === "open" ? "" : ` ${t(PR_STATE_LABEL_KEYS[hint.state])}`}
      </Text>
    </Pressable>
  );
}

/**
 * By default every state says its own name. A tick on its own has no subject — the reader has to
 * already know the glyph is about CI to read it at all, and sitting after a host and a change
 * request it reads as something left over. One short word costs less than that ambiguity, which
 * is why icon-and-text is the default and dropping the word is something you ask for.
 *
 * The words are the outcome, not the noun: "passed" against "failed", both naming how a finished
 * run ended, "running" for one still deciding. Repeating the subject on every healthy row —
 * "checks passed" — is the noise worth avoiding; naming the outcome is not.
 *
 * The accessible name is on the wrapper either way, so turning the word off shrinks the row
 * without taking the state away from a screen reader.
 */
function ChecksItem({ summary, label }: { summary: CheckSummary; label: boolean }) {
  const { t } = useTranslation();
  return (
    <View
      style={styles.item}
      accessibilityLabel={t(CHECK_STATE_ACCESSIBLE_KEYS[summary.state])}
      testID={`sidebar-workspace-checks-${summary.state}`}
    >
      <CheckIndicator summary={summary} size={META_ICON_SIZE} />
      {label ? (
        <Text style={checksTextStyle(summary.state)} numberOfLines={1}>
          {t(CHECK_STATE_LABEL_KEYS[summary.state])}
        </Text>
      ) : null}
    </View>
  );
}

const CHECK_STATE_LABEL_KEYS = {
  passed: "workspace.git.pr.checksSummary.passedLabel",
  failed: "workspace.git.pr.checksSummary.failedLabel",
  running: "workspace.git.pr.checksSummary.runningLabel",
} as const;

const CHECK_STATE_ACCESSIBLE_KEYS = {
  passed: "workspace.git.pr.checksSummary.passedAccessible",
  failed: "workspace.git.pr.checksSummary.failedAccessible",
  running: "workspace.git.pr.checksSummary.runningAccessible",
} as const;

/**
 * A running service, named. It is the one item on the line whose text is arbitrary — everything
 * else is a number, a short word, or a host label the user already picked — so it is also the
 * only one allowed to shrink, and it truncates rather than pushing the line past the row.
 *
 * A failed health check turns the whole item danger, glyph and name together. Colouring only the
 * glyph would leave the name reading as fine, and the name is the part you look at.
 */
function ServiceItem({ summary }: { summary: WorkspaceServiceSummary }) {
  const { t } = useTranslation();
  const unhealthy = summary.health === "unhealthy";
  return (
    <View
      style={styles.serviceItem}
      accessibilityLabel={t(workspaceServiceLabelKey(summary), { name: summary.name })}
      testID={unhealthy ? "workspace-service-unhealthy" : "workspace-service"}
    >
      <ThemedGlobe size={META_ICON_SIZE} uniProps={unhealthy ? dangerMapping : successMapping} />
      <Text style={unhealthy ? styles.serviceNameUnhealthy : styles.serviceName} numberOfLines={1}>
        {summary.name}
      </Text>
    </View>
  );
}

const successMapping = (theme: Theme) => ({ color: theme.colors.statusSuccess });

const PR_ICONS = {
  open: ThemedGitPullRequest,
  merged: ThemedGitMerge,
  closed: ThemedGitPullRequestClosed,
} as const;

// Same three colours the hover card gives the same three states — a change request has one
// identity, and it shouldn't shift when you hover the row that names it.
const PR_COLOR_MAPPINGS = {
  open: successMapping,
  merged: mergedMapping,
  closed: dangerMapping,
} as const;

const PR_STATE_LABEL_KEYS = {
  merged: "workspace.git.pr.states.merged",
  closed: "workspace.git.pr.states.closed",
} as const;

function pressableItemStyle({ pressed }: { pressed: boolean }) {
  return [styles.item, pressed && styles.itemPressed];
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    minWidth: 0,
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    minWidth: 0,
    flexShrink: 0,
  },
  itemPressed: {
    opacity: 0.82,
  },
  separator: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.xs,
    lineHeight: 16,
    flexShrink: 0,
  },
  projectName: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    lineHeight: 16,
    flexShrink: 1,
    minWidth: 0,
  },
  // The one item that gives way when the line runs out of room — see `ServiceItem`.
  serviceItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 3,
    minWidth: 0,
    flexShrink: 1,
  },
  serviceName: {
    color: theme.colors.statusSuccess,
    fontSize: theme.fontSize.xs,
    lineHeight: 16,
    flexShrink: 1,
  },
  serviceNameUnhealthy: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.xs,
    lineHeight: 16,
    flexShrink: 1,
  },
  prText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
    lineHeight: 16,
    flexShrink: 0,
  },
  prTextHovered: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.xs,
    lineHeight: 16,
    flexShrink: 0,
  },
  // Matches the indicator — see COLOR_MAPPINGS in check-indicator.tsx.
  checksTextPassed: {
    color: theme.colors.statusSuccess,
    fontSize: theme.fontSize.xs,
    lineHeight: 16,
    flexShrink: 0,
  },
  checksTextFailed: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.xs,
    lineHeight: 16,
    flexShrink: 0,
  },
  checksTextRunning: {
    color: theme.colors.statusWarning,
    fontSize: theme.fontSize.xs,
    lineHeight: 16,
    flexShrink: 0,
  },
}));

// Read inside render, never into a module-scope table: touching `styles.x` at module load
// materializes the Unistyles proxy before the persisted theme has resolved, and the style
// freezes on whatever theme happened to be active first. See docs/unistyles.md.
function checksTextStyle(state: CheckSummaryState) {
  if (state === "failed") return styles.checksTextFailed;
  if (state === "running") return styles.checksTextRunning;
  return styles.checksTextPassed;
}
