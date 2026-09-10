import { PluginClientStateProvider } from "@getpaseo/plugin/client/host";
import type {
  PluginButtonBehavior,
  PluginButtonIcon,
  PluginButtonMenuEntry,
  PluginHostProps,
} from "@getpaseo/plugin/client";
import type { PluginTheme } from "@getpaseo/plugin";
import { useCallback, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { Platform, Pressable, Text, View, useWindowDimensions } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { AlertCircle, ChevronDown, MoreHorizontal } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import {
  MenuRoot,
  MenuTrigger,
  MenuSurface,
  MenuItem,
  MenuSeparator,
  MenuSubTrigger,
  useMenuContext,
  type MenuPageDefinition,
} from "@/components/ui/menu";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { HEADER_CONTROL_HEIGHT } from "@/components/ui/control-geometry";
import {
  iconButtonChromeStyle,
  type IconButtonChromeState,
} from "@/components/ui/icon-button-chrome";
import { composerPillStyles } from "@/composer/pill-styles";
import { useIsCompactFormFactor } from "@/constants/layout";
import { ToastApiProvider, useToast } from "@/contexts/toast-context";
import { useHostRuntimeClient, useHosts } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import { createPluginClientStateSource } from "../client-state/source";
import { Icon } from "../icons";
import { PluginRuntimeBoundary } from "../runtime-boundary";
import { createPluginSurfaceRuntime, type PluginSurfaceRuntime } from "../surface-runtime";
import { SurfaceErrorBoundary } from "../surface-error-boundary";
import { toPluginTheme } from "../theme";
import { buttonMatches, type RegisteredPluginButton } from "./model";
import { pluginButtonStore } from "./store";

interface ButtonView {
  entry: RegisteredPluginButton;
  props: PluginHostProps & RegisteredPluginButton["context"];
  runtime: PluginSurfaceRuntime;
  state: ReturnType<typeof createPluginClientStateSource>;
  toast: ReturnType<typeof useToast>;
}

const ROOT_PATH: readonly string[] = [];

const pluginThemeMapping = (theme: Theme) => ({ theme: toPluginTheme(theme) });
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const errorIconMapping = (theme: Theme) => ({ color: theme.colors.statusDanger });
const ThemedMoreIcon = withUnistyles(MoreHorizontal);
const ThemedErrorIcon = withUnistyles(AlertCircle);

function headerButtonStyle(compact: boolean, state: IconButtonChromeState, disabled = false) {
  if (compact) return iconButtonChromeStyle({ size: "large", state, disabled });
  return [
    styles.headerButton,
    styles.button,
    (state.hovered || state.pressed || state.open) && styles.active,
    disabled && styles.disabled,
  ];
}

function resolvePlatform(): PluginHostProps["layout"]["platform"] {
  if (Platform.OS === "ios") return "ios";
  if (Platform.OS === "android") return "android";
  return "web";
}

// These providers live inside the surface content as well as around its trigger. Native sheets
// teleport their children, so providers around MenuRoot alone cannot reach the plugin body.
function ButtonEnvironment({ view, children }: { view: ButtonView; children: ReactNode }) {
  return (
    <ToastApiProvider api={view.toast}>
      <PluginRuntimeBoundary plugin={view.entry.installation} runtime={view.runtime}>
        <PluginClientStateProvider source={view.state}>{children}</PluginClientStateProvider>
      </PluginRuntimeBoundary>
    </ToastApiProvider>
  );
}

function ButtonIcon({ view, icon }: { view: ButtonView; icon: PluginButtonIcon }) {
  const color = view.props.theme.colors.foregroundMuted;
  const size = view.entry.placement === "composer" ? 14 : 16;
  return (
    <View
      style={styles.icon}
      pointerEvents="none"
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {typeof icon === "string" ? (
        <Icon name={icon} size={size} color={color} />
      ) : (
        renderCustomIcon(icon, view, size, color)
      )}
    </View>
  );
}

function renderCustomIcon(
  CustomIcon: Exclude<PluginButtonIcon, string>,
  view: ButtonView,
  size: number,
  color: string,
) {
  return <CustomIcon {...view.props} size={size} color={color} />;
}

function pressButton(view: ButtonView, path: readonly string[]) {
  void pluginButtonStore.run(view.entry.key, path).catch((error: unknown) => {
    view.toast.error(error instanceof Error ? error.message : String(error));
  });
}

function visibleMenuItems(
  items: readonly PluginButtonMenuEntry[],
): readonly PluginButtonMenuEntry[] {
  const visible: PluginButtonMenuEntry[] = [];
  for (const item of items) {
    if (item.kind === "item" && item.visible === false) continue;
    if (item.kind === "separator" && (visible.length === 0 || visible.at(-1)?.kind === "separator"))
      continue;
    visible.push(item);
  }
  if (visible.at(-1)?.kind === "separator") visible.pop();
  return visible;
}

function ButtonMenuItem({
  view,
  title,
  icon,
  behavior,
  disabled,
  path,
  pageId,
}: {
  view: ButtonView;
  title: string;
  icon?: PluginButtonIcon;
  behavior: PluginButtonBehavior;
  disabled: boolean;
  path: readonly string[];
  pageId: string;
}) {
  const select = useCallback(() => pressButton(view, path), [view, path]);
  const leading = useMemo(
    () => (icon ? <ButtonIcon view={view} icon={icon} /> : null),
    [icon, view],
  );
  if (behavior.kind !== "action") {
    return (
      <MenuSubTrigger id={pageId} leading={leading} disabled={disabled}>
        {title}
      </MenuSubTrigger>
    );
  }
  return (
    <MenuItem onSelect={select} leading={leading} disabled={disabled}>
      {title}
    </MenuItem>
  );
}

function ButtonBody({
  view,
  behavior,
  path,
}: {
  view: ButtonView;
  behavior: PluginButtonBehavior;
  path: readonly string[];
}) {
  const menu = useMenuContext("PluginButton");
  const close = useCallback(() => menu.setOpen(false), [menu]);
  if (behavior.kind === "popover") {
    const Content = behavior.Content;
    return (
      <View style={styles.content}>
        <Content {...view.props} close={close} />
      </View>
    );
  }
  if (behavior.kind !== "menu") return null;
  return visibleMenuItems(behavior.items).map((item) => {
    if (item.kind === "separator") return <MenuSeparator key={item.id} />;
    const itemPath = [...path, item.id];
    return (
      <ButtonMenuItem
        key={item.id}
        view={view}
        title={item.title}
        icon={item.icon}
        behavior={item.behavior}
        disabled={view.entry.pending || view.entry.button.disabled || item.disabled === true}
        path={itemPath}
        pageId={buttonPageId(view, itemPath)}
      />
    );
  });
}

function ButtonSurfaceBody({
  view,
  behavior,
  path,
}: {
  view: ButtonView;
  behavior: PluginButtonBehavior;
  path: readonly string[];
}) {
  return (
    <ButtonEnvironment view={view}>
      <SurfaceErrorBoundary installation={view.entry.installation} Surface={behavior}>
        <ButtonBody view={view} behavior={behavior} path={path} />
      </SurfaceErrorBoundary>
    </ButtonEnvironment>
  );
}

function buttonPageId(view: ButtonView, path: readonly string[]): string {
  return [view.entry.key, ...path].join("/");
}

function buttonPages(
  view: ButtonView,
  behavior: PluginButtonBehavior,
  path: readonly string[] = [],
): MenuPageDefinition[] {
  if (behavior.kind !== "menu") return [];
  return behavior.items.flatMap((item) => {
    if (item.kind === "separator" || item.visible === false || item.behavior.kind === "action")
      return [];
    const itemPath = [...path, item.id];
    return [
      {
        id: buttonPageId(view, itemPath),
        title: item.title,
        hoverIntent: item.behavior.kind === "menu",
        content: <ButtonSurfaceBody view={view} behavior={item.behavior} path={itemPath} />,
      },
      ...buttonPages(view, item.behavior, itemPath),
    ];
  });
}

function ButtonControl({ view }: { view: ButtonView }) {
  const { entry, props } = view;
  const { button } = entry;
  const composer = entry.placement === "composer";
  const disabled = button.disabled || entry.pending;
  const expanded = button.behavior.kind !== "action";
  const chevron = !composer && !props.layout.compact && expanded;
  let label = button.label;
  if (composer) label = button.label ?? button.title;
  else if (props.layout.compact) label = undefined;
  const press = useCallback(() => pressButton(view, []), [view]);
  const setOpen = useCallback(
    (open: boolean) => pluginButtonStore.setOpen(entry.key, open),
    [entry.key],
  );
  const buttonStyle = useCallback(
    ({ hovered, pressed }: { hovered?: boolean; pressed: boolean }) =>
      composer
        ? [
            composerPillStyles.body,
            styles.button,
            (hovered || pressed || entry.open) && styles.active,
            disabled && styles.disabled,
          ]
        : headerButtonStyle(props.layout.compact, { hovered, pressed, open: entry.open }, disabled),
    [composer, disabled, entry.open, props.layout.compact],
  );
  const contents = (
    <>
      {entry.pending ? (
        <View style={styles.icon}>
          <LoadingSpinner size={14} color={props.theme.colors.foregroundMuted} />
        </View>
      ) : (
        <ButtonIcon view={view} icon={button.icon} />
      )}
      {label ? (
        <Text numberOfLines={1} style={composer ? styles.composerLabel : styles.label}>
          {label}
        </Text>
      ) : null}
      {chevron ? (
        <View testID="plugin-button-chevron">
          <ChevronDown size={12} color={props.theme.colors.foregroundMuted} />
        </View>
      ) : null}
    </>
  );
  const accessibilityState = useMemo(
    () => ({ busy: entry.pending, disabled }),
    [entry.pending, disabled],
  );
  const trigger = expanded ? (
    <MenuTrigger
      accessibilityRole="button"
      accessibilityLabel={button.title}
      accessibilityState={accessibilityState}
      disabled={disabled}
      style={buttonStyle}
    >
      {contents}
    </MenuTrigger>
  ) : (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={button.title}
      accessibilityState={accessibilityState}
      disabled={disabled}
      onPress={press}
      style={buttonStyle}
    >
      {contents}
    </Pressable>
  );
  const pages = useMemo(() => buttonPages(view, button.behavior), [view, button.behavior]);
  return (
    <MenuRoot compactMode="sheet" open={entry.open} onOpenChange={setOpen}>
      <Tooltip enabledOnMobile={false}>
        <TooltipTrigger asChild>{trigger}</TooltipTrigger>
        <TooltipContent>
          <Text style={styles.tooltipLabel}>{button.title}</Text>
        </TooltipContent>
      </Tooltip>
      {expanded ? (
        <MenuSurface
          sheetTitle={button.title}
          side={composer ? "top" : "bottom"}
          align={composer ? "start" : "end"}
          offset={composer ? 12 : 4}
          minWidth={280}
          maxWidth={420}
          maxHeight={440}
          scrollable
          pages={pages}
        >
          <ButtonSurfaceBody view={view} behavior={button.behavior} path={ROOT_PATH} />
        </MenuSurface>
      ) : null}
    </MenuRoot>
  );
}

function BrokenButton({
  title,
  error,
  compact,
}: {
  title: string;
  error: string;
  compact: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        accessibilityRole="button"
        accessibilityLabel={title}
        disabled
        style={headerButtonStyle(compact, {}, true)}
      >
        <ThemedErrorIcon size={16} uniProps={errorIconMapping} />
      </TooltipTrigger>
      <TooltipContent>
        <Text style={styles.tooltipLabel}>{error}</Text>
      </TooltipContent>
    </Tooltip>
  );
}

function createButtonView({
  entry,
  client,
  toast,
  compact,
  hostLabel,
  theme,
}: {
  entry: RegisteredPluginButton;
  client: ReturnType<typeof useHostRuntimeClient>;
  toast: ReturnType<typeof useToast>;
  compact: boolean;
  hostLabel: string;
  theme: PluginTheme;
}): ButtonView | null {
  const runtime = createPluginSurfaceRuntime(client, entry.installation.id);
  if (!runtime) return null;
  return {
    entry,
    runtime,
    toast,
    state: createPluginClientStateSource(entry.installation.serverId),
    props: {
      ...entry.context,
      theme,
      host: { id: entry.installation.serverId, label: hostLabel },
      layout: { compact, platform: resolvePlatform() },
    },
  };
}

function PluginButtonHost({
  entry,
  compact,
  hostLabel,
  theme,
}: {
  entry: RegisteredPluginButton;
  compact: boolean;
  hostLabel: string;
  theme: PluginTheme;
}) {
  const client = useHostRuntimeClient(entry.installation.serverId);
  const toast = useToast();
  const view = useMemo(
    () => createButtonView({ entry, client, toast, compact, hostLabel, theme }),
    [entry, client, toast, compact, hostLabel, theme],
  );
  const renderError = useCallback(
    (error: string) => <BrokenButton title={entry.button.title} error={error} compact={compact} />,
    [entry.button.title, compact],
  );
  if (!view) return null;
  return (
    <SurfaceErrorBoundary
      installation={entry.installation}
      Surface={entry.button.icon}
      renderError={renderError}
    >
      <ButtonEnvironment view={view}>
        <ButtonControl view={view} />
      </ButtonEnvironment>
    </SurfaceErrorBoundary>
  );
}

const ThemedPluginButton = withUnistyles(PluginButtonHost);

// Overflow rows keep their own plugin runtime; a menu can contain several installations.
function OverflowButton({ view }: { view: ButtonView }) {
  const { button } = view.entry;
  return (
    <ButtonMenuItem
      view={view}
      title={button.title}
      icon={button.icon}
      behavior={button.behavior}
      disabled={button.disabled || view.entry.pending}
      path={ROOT_PATH}
      pageId={buttonPageId(view, [])}
    />
  );
}

function OverflowPages({
  entries,
  compact,
  hostLabel,
  theme,
}: {
  entries: readonly RegisteredPluginButton[];
  compact: boolean;
  hostLabel: string;
  theme: PluginTheme;
}) {
  // The header belongs to one host, but each button keeps its installation's query cache and RPCs.
  const client = useHostRuntimeClient(entries[0].installation.serverId);
  const toast = useToast();
  const menuContent = useMemo(() => {
    const pages: MenuPageDefinition[] = [];
    const rows: ReactNode[] = [];
    for (const entry of entries) {
      const view = createButtonView({ entry, client, toast, compact, hostLabel, theme });
      if (!view) continue;
      rows.push(
        <ButtonEnvironment key={entry.key} view={view}>
          <SurfaceErrorBoundary installation={entry.installation} Surface={entry.button.icon}>
            <OverflowButton view={view} />
          </SurfaceErrorBoundary>
        </ButtonEnvironment>,
      );
      if (entry.button.behavior.kind === "action") continue;
      pages.push(
        {
          id: buttonPageId(view, []),
          title: entry.button.title,
          hoverIntent: false,
          content: (
            <ButtonSurfaceBody view={view} behavior={entry.button.behavior} path={ROOT_PATH} />
          ),
        },
        ...buttonPages(view, entry.button.behavior),
      );
    }
    return { pages, rows };
  }, [entries, client, toast, theme, hostLabel, compact]);
  const { t } = useTranslation();
  return (
    <MenuSurface
      sheetTitle={t("workspace.git.actions.moreActions")}
      align="end"
      minWidth={280}
      maxWidth={420}
      maxHeight={440}
      scrollable
      pages={menuContent.pages}
    >
      {menuContent.rows}
    </MenuSurface>
  );
}

const ThemedOverflowPages = withUnistyles(OverflowPages);

function useButtons(serverId: string, workspaceId: string, agentId: string | null) {
  const entries = useSyncExternalStore(
    pluginButtonStore.subscribe,
    pluginButtonStore.getSnapshot,
    pluginButtonStore.getSnapshot,
  );
  return useMemo(
    () => entries.filter((entry) => buttonMatches(entry, serverId, workspaceId, agentId)),
    [entries, serverId, workspaceId, agentId],
  );
}

export function useHasPluginComposerPills(
  serverId: string,
  workspaceId: string,
  agentId: string,
): boolean {
  return useButtons(serverId, workspaceId, agentId).length > 0;
}

export function PluginComposerPills({
  serverId,
  workspaceId,
  agentId,
  compact,
}: {
  serverId: string;
  workspaceId: string;
  agentId: string;
  compact: boolean;
}) {
  const entries = useButtons(serverId, workspaceId, agentId);
  const hosts = useHosts();
  const hostLabel = hosts.find((host) => host.serverId === serverId)?.label ?? serverId;
  return entries.map((entry) => (
    <ThemedPluginButton
      key={entry.key}
      entry={entry}
      compact={compact}
      hostLabel={hostLabel}
      uniProps={pluginThemeMapping}
    />
  ));
}

export function PluginHeaderButtons({
  serverId,
  workspaceId,
}: {
  serverId: string;
  workspaceId: string;
}) {
  const entries = useButtons(serverId, workspaceId, null);
  const compact = useIsCompactFormFactor();
  const { width } = useWindowDimensions();
  const hosts = useHosts();
  const { t } = useTranslation();
  const hostLabel = hosts.find((host) => host.serverId === serverId)?.label ?? serverId;
  const limit = compact || width < 1100 ? 1 : 3;
  const visible = entries.slice(0, limit);
  const overflow = entries.slice(limit);
  const overflowStyle = useCallback(
    (state: IconButtonChromeState) => headerButtonStyle(compact, state),
    [compact],
  );
  if (entries.length === 0) return null;
  return (
    <View
      accessibilityRole="toolbar"
      accessibilityLabel={t("workspace.header.actions.workspaceActions")}
      style={styles.headerButtons}
    >
      {visible.map((entry) => (
        <ThemedPluginButton
          key={entry.key}
          entry={entry}
          compact={compact}
          hostLabel={hostLabel}
          uniProps={pluginThemeMapping}
        />
      ))}
      {overflow.length > 0 ? (
        <MenuRoot compactMode="sheet">
          <MenuTrigger
            accessibilityRole="button"
            accessibilityLabel={t("workspace.git.actions.moreActions")}
            style={overflowStyle}
          >
            <ThemedMoreIcon size={16} uniProps={mutedIconMapping} />
          </MenuTrigger>
          <ThemedOverflowPages
            entries={overflow}
            compact={compact}
            hostLabel={hostLabel}
            uniProps={pluginThemeMapping}
          />
        </MenuRoot>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  headerButtons: {
    flexDirection: "row",
    alignItems: "center",
    gap: { xs: theme.spacing[1], md: theme.spacing[2] },
  },
  headerButton: {
    height: { xs: 32, md: HEADER_CONTROL_HEIGHT },
    minWidth: { xs: 32, md: HEADER_CONTROL_HEIGHT },
    paddingHorizontal: theme.spacing[2],
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.borderAccent,
  },
  button: { flexShrink: 1, minWidth: 0, maxWidth: 160 },
  active: { backgroundColor: theme.colors.surface2 },
  disabled: { opacity: theme.opacity[50] },
  tooltipLabel: { fontSize: theme.fontSize.sm, color: theme.colors.foreground },
  composerLabel: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
    flexShrink: 1,
  },
  label: { fontSize: theme.fontSize.sm, color: theme.colors.foregroundMuted, flexShrink: 1 },
  icon: {
    width: 16,
    height: 16,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    overflow: "hidden",
  },
  content: { padding: theme.spacing[3], gap: theme.spacing[2] },
}));
