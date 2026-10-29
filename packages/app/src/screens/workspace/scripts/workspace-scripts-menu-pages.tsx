import { useCallback, useMemo, type ReactElement } from "react";
import { View } from "react-native";
import { Copy, Eye, Play, RotateCw, Square, SquareTerminal } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSubTrigger,
  type MenuPageDefinition,
} from "@/components/ui/dropdown-menu";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import type { Theme } from "@/styles/theme";
import { openServiceUrl } from "@/utils/open-service-url";
import type {
  WorkspaceScriptLinkKind,
  WorkspaceScriptLinkTarget,
} from "@/utils/workspace-script-links";
import { ExitCodeBadge, routeLabelKey, ScriptIcon } from "./script-marks";
import { scriptToneColorMapping, summarizeScripts, type ScriptsSummary } from "./script-status";
import {
  useWorkspaceScriptActions,
  type WorkspaceScriptActions,
} from "./use-workspace-script-actions";

type WorkspaceScript = WorkspaceDescriptor["scripts"][number];

const ThemedPlay = withUnistyles(Play);
const ThemedEye = withUnistyles(Eye);
const ThemedSquareTerminal = withUnistyles(SquareTerminal);
const ThemedCopy = withUnistyles(Copy);
const ThemedRotateCw = withUnistyles(RotateCw);
const ThemedSquare = withUnistyles(Square);

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const playFillTransparent = { fill: "transparent" };

const ROW_ICON_SIZE = 16;
const TRAILING_ICON_SIZE = 14;

const OPEN_SERVICE_ICON = <ThemedEye size={ROW_ICON_SIZE} uniProps={mutedColorMapping} />;
const VIEW_TERMINAL_ICON = (
  <ThemedSquareTerminal size={ROW_ICON_SIZE} uniProps={mutedColorMapping} />
);
const COPY_URL_ICON = <ThemedCopy size={ROW_ICON_SIZE} uniProps={mutedColorMapping} />;
const RESTART_ICON = <ThemedRotateCw size={ROW_ICON_SIZE} uniProps={mutedColorMapping} />;
const STOP_ICON = <ThemedSquare size={ROW_ICON_SIZE} uniProps={mutedColorMapping} />;
const RUN_ICON = (
  <ThemedPlay size={ROW_ICON_SIZE} uniProps={mutedColorMapping} {...playFillTransparent} />
);

const SCRIPTS_PAGE_ID = "workspace-scripts";

function scriptPageId(scriptName: string): string {
  return `${SCRIPTS_PAGE_ID}/${scriptName}`;
}

export interface UseWorkspaceScriptsMenuPagesInput {
  serverId: string;
  workspaceId: string;
  scripts: WorkspaceDescriptor["scripts"];
  liveTerminalIds: readonly string[];
  onScriptTerminalStarted: (terminalId: string) => void;
  onViewTerminal: (terminalId: string) => void;
  onOpenUrlInBrowserTab: (url: string) => void;
}

export interface WorkspaceScriptsMenuPages {
  /** The root row that leads to the scripts page. Null when the workspace has no scripts. */
  trigger: ReactElement | null;
  pages: MenuPageDefinition[];
  /** A running service reports unhealthy, so the menu's own trigger should say so. */
  needsAttention: boolean;
}

/**
 * Workspace scripts as pages of a sheet menu: a Scripts row on the root, a page listing every
 * script, and one page per script.
 *
 * Every script gets a page whether or not it runs, so stopping one from its own page flips that
 * page to its stopped state instead of pulling it out from under the user.
 *
 * The actions live here rather than in a page, so call this from whatever owns the menu: a restart
 * finishes after the sheet has closed.
 */
export function useWorkspaceScriptsMenuPages({
  serverId,
  workspaceId,
  scripts,
  liveTerminalIds,
  onScriptTerminalStarted,
  onViewTerminal,
  onOpenUrlInBrowserTab,
}: UseWorkspaceScriptsMenuPagesInput): WorkspaceScriptsMenuPages {
  const { t } = useTranslation();
  const actions = useWorkspaceScriptActions({
    serverId,
    workspaceId,
    scripts,
    onScriptTerminalStarted,
  });
  const summary = useMemo(() => summarizeScripts(scripts), [scripts]);

  const trigger = useMemo(
    () => (scripts.length === 0 ? null : <ScriptsMenuTrigger summary={summary} />),
    [scripts.length, summary],
  );

  const pages = useMemo<MenuPageDefinition[]>(() => {
    if (scripts.length === 0) return [];
    const liveTerminalIdSet = new Set(liveTerminalIds);
    return [
      {
        id: SCRIPTS_PAGE_ID,
        title: t("workspace.scripts.title"),
        content: <ScriptsPage scripts={scripts} actions={actions} />,
      },
      ...scripts.map((script) => ({
        id: scriptPageId(script.scriptName),
        title: script.scriptName,
        content: (
          <ScriptPage
            script={script}
            actions={actions}
            liveTerminalId={
              script.terminalId && liveTerminalIdSet.has(script.terminalId)
                ? script.terminalId
                : null
            }
            onViewTerminal={onViewTerminal}
            onOpenUrlInBrowserTab={onOpenUrlInBrowserTab}
          />
        ),
      })),
    ];
  }, [actions, liveTerminalIds, onOpenUrlInBrowserTab, onViewTerminal, scripts, t]);

  return { trigger, pages, needsAttention: summary.tone === "unhealthy" };
}

/** The root row: ▶ in the colour of the whole set, and what is running as its value. */
function ScriptsMenuTrigger({ summary }: { summary: ScriptsSummary }): ReactElement {
  const { t } = useTranslation();
  const leading = useMemo(
    () => (
      <ThemedPlay
        size={ROW_ICON_SIZE}
        uniProps={scriptToneColorMapping(summary.tone)}
        {...playFillTransparent}
      />
    ),
    [summary.tone],
  );
  const [onlyRunning] = summary.running;
  const value =
    summary.running.length > 1
      ? t("workspace.scripts.states.runningCount", { count: summary.running.length })
      : onlyRunning;
  return (
    <DropdownMenuSubTrigger
      id={SCRIPTS_PAGE_ID}
      value={value}
      leading={leading}
      testID="workspace-header-scripts"
    >
      {t("workspace.scripts.title")}
    </DropdownMenuSubTrigger>
  );
}

function ScriptsPage({
  scripts,
  actions,
}: {
  scripts: WorkspaceDescriptor["scripts"];
  actions: WorkspaceScriptActions;
}): ReactElement {
  return (
    <>
      {scripts.map((script) =>
        script.lifecycle === "running" ? (
          <RunningScriptRow key={script.scriptName} script={script} />
        ) : (
          <StoppedScriptRow key={script.scriptName} script={script} actions={actions} />
        ),
      )}
    </>
  );
}

function RunningScriptRow({ script }: { script: WorkspaceScript }): ReactElement {
  const { t } = useTranslation();
  const leading = useMemo(() => <ScriptIcon script={script} size={ROW_ICON_SIZE} />, [script]);
  return (
    <DropdownMenuSubTrigger
      id={scriptPageId(script.scriptName)}
      value={t("workspace.scripts.states.running")}
      leading={leading}
      testID={`workspace-scripts-row-${script.scriptName}`}
    >
      {script.scriptName}
    </DropdownMenuSubTrigger>
  );
}

/** Pressing a stopped script runs it. Starting opens its terminal tab, so the sheet closes. */
function StoppedScriptRow({
  script,
  actions,
}: {
  script: WorkspaceScript;
  actions: WorkspaceScriptActions;
}): ReactElement {
  const { start } = actions;
  const handleSelect = useCallback(() => start(script.scriptName), [start, script.scriptName]);
  const exitCode = script.exitCode ?? null;
  const leading = useMemo(() => <ScriptIcon script={script} size={ROW_ICON_SIZE} />, [script]);
  const trailing = useMemo(
    () => (
      <View style={styles.trailing}>
        {exitCode === null ? null : <ExitCodeBadge code={exitCode} />}
        <ThemedPlay
          size={TRAILING_ICON_SIZE}
          uniProps={mutedColorMapping}
          {...playFillTransparent}
        />
      </View>
    ),
    [exitCode],
  );
  return (
    <DropdownMenuItem
      leading={leading}
      trailing={trailing}
      disabled={actions.isStartPending}
      onSelect={handleSelect}
      testID={`workspace-scripts-row-${script.scriptName}`}
    >
      {script.scriptName}
    </DropdownMenuItem>
  );
}

interface ScriptPageProps {
  script: WorkspaceScript;
  actions: WorkspaceScriptActions;
  liveTerminalId: string | null;
  onViewTerminal: (terminalId: string) => void;
  onOpenUrlInBrowserTab: (url: string) => void;
}

function ScriptPage(props: ScriptPageProps): ReactElement {
  return props.script.lifecycle === "running" ? (
    <RunningScriptPage {...props} />
  ) : (
    <StoppedScriptPage script={props.script} actions={props.actions} />
  );
}

/**
 * Rows that open something — the service, the terminal, the clipboard toast — close the sheet.
 * Stop and the URL choice stay: the page is where their result shows.
 */
function RunningScriptPage({
  script,
  actions,
  liveTerminalId,
  onViewTerminal,
  onOpenUrlInBrowserTab,
}: ScriptPageProps): ReactElement {
  const { t } = useTranslation();
  const { scriptName } = script;
  const { selected, targets } = actions.resolveLinks(script);
  const { stop, restart, copyUrl, selectRoute } = actions;

  const handleOpenService = useCallback(() => {
    if (!selected) return;
    void openServiceUrl(selected.url, { openInApp: onOpenUrlInBrowserTab });
  }, [selected, onOpenUrlInBrowserTab]);
  const handleViewTerminal = useCallback(() => {
    if (liveTerminalId) onViewTerminal(liveTerminalId);
  }, [liveTerminalId, onViewTerminal]);
  const handleCopyUrl = useCallback(() => {
    if (selected) copyUrl(selected);
  }, [selected, copyUrl]);
  const handleRestart = useCallback(() => restart(scriptName), [restart, scriptName]);
  const handleStop = useCallback(() => stop(scriptName), [stop, scriptName]);

  return (
    <>
      {selected ? (
        <DropdownMenuItem
          leading={OPEN_SERVICE_ICON}
          onSelect={handleOpenService}
          testID={`workspace-script-${scriptName}-open`}
        >
          {t("workspace.scripts.actions.openService")}
        </DropdownMenuItem>
      ) : null}
      {liveTerminalId ? (
        <DropdownMenuItem
          leading={VIEW_TERMINAL_ICON}
          onSelect={handleViewTerminal}
          testID={`workspace-script-${scriptName}-view`}
        >
          {t("workspace.scripts.actions.view")}
        </DropdownMenuItem>
      ) : null}
      {selected ? (
        <DropdownMenuItem
          leading={COPY_URL_ICON}
          description={selected.label}
          onSelect={handleCopyUrl}
          testID={`workspace-script-${scriptName}-copy`}
        >
          {t("workspace.scripts.actions.copyUrl")}
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuItem
        leading={RESTART_ICON}
        disabled={actions.isStopPending}
        onSelect={handleRestart}
        testID={`workspace-script-${scriptName}-restart`}
      >
        {t("workspace.scripts.actions.restart")}
      </DropdownMenuItem>
      <DropdownMenuItem
        leading={STOP_ICON}
        disabled={actions.isStopPending}
        closeOnSelect={false}
        onSelect={handleStop}
        testID={`workspace-script-${scriptName}-stop`}
      >
        {t("workspace.scripts.actions.stop")}
      </DropdownMenuItem>
      {selected && targets.length > 1 ? (
        <>
          <DropdownMenuSeparator />
          {targets.map((target) => (
            <ServiceRouteOption
              key={target.kind}
              scriptName={scriptName}
              target={target}
              selected={target.kind === selected.kind}
              onSelect={selectRoute}
            />
          ))}
        </>
      ) : null}
    </>
  );
}

/** A pick-one URL route. Choosing one keeps the page open so the check moves under the thumb. */
function ServiceRouteOption({
  scriptName,
  target,
  selected,
  onSelect,
}: {
  scriptName: string;
  target: WorkspaceScriptLinkTarget;
  selected: boolean;
  onSelect: (kind: WorkspaceScriptLinkKind) => void;
}): ReactElement {
  const { t } = useTranslation();
  const handleSelect = useCallback(() => onSelect(target.kind), [onSelect, target.kind]);
  return (
    <DropdownMenuItem
      selected={selected}
      showSelectedCheck
      description={target.label}
      closeOnSelect={false}
      onSelect={handleSelect}
      testID={`workspace-script-${scriptName}-route-${target.kind}`}
    >
      {t(routeLabelKey(target.kind))}
    </DropdownMenuItem>
  );
}

function StoppedScriptPage({
  script,
  actions,
}: {
  script: WorkspaceScript;
  actions: WorkspaceScriptActions;
}): ReactElement {
  const { t } = useTranslation();
  const { start } = actions;
  const handleRun = useCallback(() => start(script.scriptName), [start, script.scriptName]);
  const exitCode = script.exitCode ?? null;
  const trailing = useMemo(
    () => (exitCode === null ? null : <ExitCodeBadge code={exitCode} />),
    [exitCode],
  );
  return (
    <DropdownMenuItem
      leading={RUN_ICON}
      trailing={trailing}
      disabled={actions.isStartPending}
      onSelect={handleRun}
      testID={`workspace-script-${script.scriptName}-run`}
    >
      {t("workspace.scripts.actions.run")}
    </DropdownMenuItem>
  );
}

const styles = StyleSheet.create((theme) => ({
  trailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
  },
}));
