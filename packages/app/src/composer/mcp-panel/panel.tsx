import { useCallback, type ReactElement } from "react";
import { Pressable, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import {
  Check,
  CircleAlert,
  CircleDashed,
  CircleSlash,
  LoaderCircle,
  Plug,
  RefreshCw,
} from "lucide-react-native";
import type { AgentMcpServer } from "@getpaseo/protocol/agent-types";
import {
  MenuRoot,
  MenuSeparator,
  MenuSurface,
  MenuTrigger,
  useMenuContext,
  type MenuTriggerState,
} from "@/components/ui/menu";
import type { Theme } from "@/styles/theme";
import { getMcpStatusPresentation, type McpStatusTone } from "./status";
import type { AgentMcpSource } from "./types";

/** What a row shows when the report carries no per-server state at all. */
const NEUTRAL_PRESENTATION = { tone: "muted", labelKey: null } as const;
import type { AgentMcpServersView } from "./types";

/**
 * Panel geometry. Narrower than the track panels because a row is a name and one short status,
 * not a task description — but tall, because the list is however many servers the runtime has
 * and a host with every connector enabled runs to twenty.
 */
const PANEL_MIN_WIDTH = 260;
const PANEL_MAX_WIDTH = 420;
const PANEL_MAX_HEIGHT = 460;
const PANEL_OFFSET = 12;

const ROW_ICON_SIZE = 14;

const toneColor =
  (tone: McpStatusTone) =>
  (theme: Theme): { color: string } => {
    switch (tone) {
      case "success":
        return { color: theme.colors.statusSuccess };
      case "warning":
        return { color: theme.colors.statusWarning };
      case "danger":
        return { color: theme.colors.statusDanger };
      case "muted":
        return { color: theme.colors.foregroundMuted };
    }
  };

// One uniProps function per tone, resolved once: `withUnistyles` takes a function of the theme,
// so a tone cannot be threaded through it as an argument.
const TONE_UNI_PROPS = {
  success: toneColor("success"),
  warning: toneColor("warning"),
  danger: toneColor("danger"),
  muted: toneColor("muted"),
} as const;

const mutedIconColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const ThemedCheck = withUnistyles(Check);
const ThemedCircleAlert = withUnistyles(CircleAlert);
const ThemedCircleDashed = withUnistyles(CircleDashed);
const ThemedCircleSlash = withUnistyles(CircleSlash);
const ThemedLoader = withUnistyles(LoaderCircle);
const ThemedPlug = withUnistyles(Plug);
const ThemedRefresh = withUnistyles(RefreshCw);

/**
 * One glyph per status, switched exhaustively rather than by falling through to the
 * alert. `configured` is the ordinary row on a configured-fidelity report, so it must
 * read as neutral — an alarm next to every server says the opposite of what is meant.
 */
function McpStatusIcon({
  server,
  source,
}: {
  server: AgentMcpServer;
  source: AgentMcpSource;
}): ReactElement {
  if (source === "configured") {
    return <ThemedCircleDashed size={ROW_ICON_SIZE} uniProps={TONE_UNI_PROPS.muted} />;
  }
  const uniProps = TONE_UNI_PROPS[getMcpStatusPresentation(server.status).tone];
  switch (server.status) {
    case "connected":
      return <ThemedCheck size={ROW_ICON_SIZE} uniProps={uniProps} />;
    case "connecting":
      return <ThemedLoader size={ROW_ICON_SIZE} uniProps={uniProps} />;
    case "disabled":
      return <ThemedCircleSlash size={ROW_ICON_SIZE} uniProps={uniProps} />;
    case "needs_auth":
    case "failed":
    case "unknown":
      return <ThemedCircleAlert size={ROW_ICON_SIZE} uniProps={uniProps} />;
  }
}

function McpServerRow({
  server,
  source,
}: {
  server: AgentMcpServer;
  source: AgentMcpSource;
}): ReactElement {
  const { t } = useTranslation();
  // A configured report knows names and nothing else. Drawing each row's `unknown` as an
  // alert glyph plus an "Unknown" label turns a normal, healthy setup into a column of
  // warnings; the footnote below the list carries the caveat once instead.
  const { labelKey } =
    source === "configured" ? NEUTRAL_PRESENTATION : getMcpStatusPresentation(server.status);
  const statusLabel = labelKey ? t(`mcpServers.status.${labelKey}`) : null;
  // A connected row deliberately shows no trailing text — the tick carries it — but the
  // tick is decorative, so without this a screen reader would read healthy, configured
  // and unrecognised rows as nothing but a name.
  const spokenStatus =
    statusLabel ??
    (source === "configured"
      ? t("mcpServers.status.configuredRow")
      : t("mcpServers.status.connected"));

  return (
    <View
      style={styles.row}
      accessibilityRole="text"
      accessibilityLabel={`${server.name}, ${spokenStatus}`}
      testID={`mcp-server-row-${server.name}`}
    >
      <McpStatusIcon server={server} source={source} />
      <View style={styles.rowText}>
        <Text style={styles.rowName} numberOfLines={1}>
          {server.name}
        </Text>
        {server.error ? (
          <Text style={styles.rowError} numberOfLines={2}>
            {server.error}
          </Text>
        ) : null}
      </View>
      {statusLabel ? (
        <Text style={styles.rowStatus} numberOfLines={1}>
          {statusLabel}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * The panel's own header. The menu engine draws a header on the sheet and never on the popover,
 * so the title is rendered here only for the popover — on compact it would sit directly under
 * the sheet's own header saying the same thing. The refresh control belongs to both.
 */
function McpPanelHeader({
  onRefresh,
  isRefreshing,
}: {
  onRefresh: () => void;
  isRefreshing: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const { presentation } = useMenuContext("McpPanelHeader");
  const refreshStyle = useCallback(
    ({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) => [
      styles.refreshButton,
      (hovered || pressed) && styles.refreshButtonActive,
      isRefreshing && styles.refreshButtonBusy,
    ],
    [isRefreshing],
  );

  return (
    <View style={styles.header}>
      {presentation === "popover" ? (
        <Text style={styles.headerTitle}>{t("mcpServers.title")}</Text>
      ) : null}
      <View style={styles.headerSpacer} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("mcpServers.refresh")}
        testID="mcp-panel-refresh"
        disabled={isRefreshing}
        onPress={onRefresh}
        style={refreshStyle}
      >
        <ThemedRefresh size={ROW_ICON_SIZE} uniProps={mutedIconColor} />
      </Pressable>
    </View>
  );
}

/** The unsupported case never reaches here — `McpServersPanel` renders nothing for it. */
function McpPanelBody({
  view,
}: {
  view: Exclude<AgentMcpServersView, { kind: "unsupported" }>;
}): ReactElement {
  const { t } = useTranslation();

  if (view.kind === "loading") {
    return <Text style={styles.message}>{t("mcpServers.loading")}</Text>;
  }
  if (view.kind === "error") {
    return <Text style={styles.messageError}>{view.message}</Text>;
  }
  if (view.servers.length === 0) {
    return <Text style={styles.message}>{t("mcpServers.empty")}</Text>;
  }
  return (
    <>
      {/*
        Above the rows, not below them. A host with twenty servers pushes anything
        trailing past the panel's max height, so the caveat that these rows are
        unverified would only be seen by someone who scrolled to the end.
      */}
      {view.source === "live" ? null : (
        <Text style={styles.sourceNote}>{t(`mcpServers.source.${view.source}`)}</Text>
      )}
      {view.servers.map((server) => (
        <McpServerRow key={server.name} server={server} source={view.source} />
      ))}
    </>
  );
}

function McpPanelTrigger({ glyphSize }: { glyphSize: number }): ReactElement {
  const { t } = useTranslation();
  const triggerStyle = useCallback(
    ({ hovered, pressed, open }: MenuTriggerState) => [
      styles.trigger,
      (hovered || pressed || open) && styles.triggerActive,
    ],
    [],
  );

  return (
    <MenuTrigger
      accessibilityRole="button"
      accessibilityLabel={t("mcpServers.open")}
      testID="mcp-panel-trigger"
      style={triggerStyle}
    >
      <ThemedPlug size={glyphSize} uniProps={mutedIconColor} />
    </MenuTrigger>
  );
}

export interface McpServersPanelProps {
  view: AgentMcpServersView;
  /** Controlled: the same flag drives the fetch, so the two cannot drift apart. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRefresh: () => void;
  /** Matches the sibling context-window meter's glyph so the two sit on one rail. */
  glyphSize: number;
}

/**
 * The plug and its panel, driven entirely by the view it is handed. Split from the connected
 * control so the surface can be exercised against every view state without a host or a daemon.
 */
export function McpServersPanel({
  view,
  open,
  onOpenChange,
  onRefresh,
  glyphSize,
}: McpServersPanelProps): ReactElement | null {
  const { t } = useTranslation();

  // A provider that cannot report MCP status gets no control at all. A panel whose
  // only content explains why it is empty is worse than nothing in the toolbar.
  if (view.kind === "unsupported") {
    return null;
  }

  return (
    <MenuRoot compactMode="sheet" open={open} onOpenChange={onOpenChange}>
      <McpPanelTrigger glyphSize={glyphSize} />
      <MenuSurface
        side="top"
        align="end"
        offset={PANEL_OFFSET}
        sheetTitle={t("mcpServers.title")}
        minWidth={PANEL_MIN_WIDTH}
        maxWidth={PANEL_MAX_WIDTH}
        maxHeight={PANEL_MAX_HEIGHT}
        scrollable
        testID="mcp-panel"
      >
        <McpPanelHeader
          onRefresh={onRefresh}
          isRefreshing={view.kind === "ready" ? view.isRefreshing : view.kind === "loading"}
        />
        <MenuSeparator />
        <McpPanelBody view={view} />
      </MenuSurface>
    </MenuRoot>
  );
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.full,
    alignItems: "center",
    justifyContent: "center",
  },
  triggerActive: {
    backgroundColor: theme.colors.surface2,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: { xs: 40, md: 32 },
    marginHorizontal: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    gap: theme.spacing[2],
  },
  headerTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  headerSpacer: {
    flex: 1,
  },
  // Sized off the breakpoint like every other menu-surface control: 28pt for a pointer,
  // 40pt below `md` for a thumb (docs/menus.md). The glyph stays 14pt either way.
  refreshButton: {
    width: { xs: 40, md: 28 },
    height: { xs: 40, md: 28 },
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  refreshButtonActive: {
    backgroundColor: theme.colors.surface2,
  },
  refreshButtonBusy: {
    opacity: 0.5,
  },
  // The panel's own row rather than the track panels'. Same rail and rhythm, but the
  // height follows the breakpoint: a compact popover is worked with a thumb just as a
  // sheet is, and the 32pt pointer row is below the tier docs/menus.md sets for it.
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: { xs: 40, md: 32 },
    marginHorizontal: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
  },
  sourceNote: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
    marginHorizontal: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingBottom: theme.spacing[2],
  },
  rowText: {
    flexShrink: 1,
    minWidth: 0,
  },
  rowName: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  rowError: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
  },
  // Pushed to the trailing edge so the statuses line up as a column against a ragged name list.
  rowStatus: {
    marginLeft: "auto",
    paddingLeft: theme.spacing[3],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  message: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
    marginHorizontal: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  messageError: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
    lineHeight: theme.fontSize.sm * 1.4,
    marginHorizontal: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
}));
