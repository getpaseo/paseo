import {
  CircleCheck,
  ChevronDown,
  ExternalLink,
  FileDiff,
  Files,
  GitPullRequest,
  PanelRight,
  Puzzle,
  RefreshCw,
  Rows3,
} from "lucide-react";
import type * as React from "react";
import { ChangesBranchRow, ChangesCommitsRow, ChangesScopeRow, ExplorerChangesTree } from "./diff";
import { RIGHT_PANEL_W, TABBAR_H, TITLEBAR_H } from "./geometry";
import type { MockupStateId } from "./states";

const TABBAR_STYLE = { height: TITLEBAR_H };
const SUBHEADER_STYLE = { height: TABBAR_H };
const PANEL_STYLE = { width: RIGHT_PANEL_W };

interface PanelTab {
  label: string;
  icon: React.ReactNode;
}

function PanelTabs({ tabs, active }: { tabs: PanelTab[]; active: number }) {
  return (
    <div
      className="flex shrink-0 items-center gap-[4px] border-b border-mock-border px-[8px]"
      style={TABBAR_STYLE}
    >
      {tabs.map((tab, index) => (
        <span
          key={tab.label}
          className={`flex items-center gap-[6px] rounded-[6px] px-[9px] py-[3px] text-[12px] ${
            index === active ? "bg-mock-surface2 text-mock-fg" : "text-mock-fg-muted"
          }`}
        >
          {tab.icon}
          {tab.label}
        </span>
      ))}
      <span className="flex-1" />
      <span className="flex size-[24px] items-center justify-center text-mock-fg-muted">
        <PanelRight size={14} />
      </span>
    </div>
  );
}

function PanelShell({
  tabs,
  active,
  children,
}: {
  tabs: PanelTab[];
  active: number;
  children: React.ReactNode;
}) {
  return (
    <div
      className="flex h-full shrink-0 flex-col overflow-hidden bg-mock-sidebar"
      style={PANEL_STYLE}
    >
      <PanelTabs tabs={tabs} active={active} />
      {children}
    </div>
  );
}

const PR_TAB_GLYPH = <GitPullRequest size={12} />;
const CHANGES_TAB_GLYPH = <FileDiff size={12} />;
const FILES_TAB_GLYPH = <Files size={12} />;

// --- Changes ---------------------------------------------------------------

const CHANGES_TABS: PanelTab[] = [
  { label: "Files", icon: FILES_TAB_GLYPH },
  { label: "Changes", icon: CHANGES_TAB_GLYPH },
  { label: "3981", icon: PR_TAB_GLYPH },
];

function ChangesPanel({ selectedFile }: { selectedFile?: string }) {
  return (
    <PanelShell tabs={CHANGES_TABS} active={1}>
      <ChangesBranchRow />
      <ChangesScopeRow />
      <ExplorerChangesTree selectedFile={selectedFile} />
      <ChangesCommitsRow />
    </PanelShell>
  );
}

// --- Ship (GitHub PR checks) ------------------------------------------------

const SHIP_TABS: PanelTab[] = CHANGES_TABS;

const CHECKS: { name: string; context: string; time: string }[] = [
  { name: "changes", context: "CI", time: "11s" },
  { name: "setup", context: "Docker", time: "5s" },
  { name: "build", context: "Docker", time: "16m 18s" },
  { name: "format", context: "CI", time: "1m 23s" },
  { name: "build-desktop-darwin", context: "Nix", time: "6m 40s" },
  { name: "lint", context: "CI", time: "1m 43s" },
  { name: "typecheck", context: "CI", time: "2m 19s" },
  { name: "server-tests (ubuntu-latest)", context: "CI", time: "7m 15s" },
  { name: "app-tests (macos)", context: "CI", time: "5m 02s" },
];

function CheckGlyph() {
  return <CircleCheck size={14} className="shrink-0 text-mock-success" />;
}

function ShipPanel() {
  return (
    <PanelShell tabs={SHIP_TABS} active={2}>
      <div
        className="flex shrink-0 items-center border-b border-mock-border px-[16px]"
        style={SUBHEADER_STYLE}
      >
        <span className="flex items-center gap-[6px] text-[12px] text-mock-fg-muted">
          <ExternalLink size={13} />
          View
        </span>
        <span className="flex-1" />
        <RefreshCw size={13} className="text-mock-fg-muted" />
      </div>

      <div className="px-[16px] pt-[13px] pb-[11px]">
        <div className="text-[13.5px] leading-[18px] text-mock-fg">
          Lay the foundation for granular daemon permissions{" "}
          <span className="text-mock-fg-muted">#3981</span>
        </div>
        <div className="flex items-center gap-[7px] pt-[6px] text-[11.5px]">
          <span className="flex items-center gap-[5px] text-mock-success">
            <GitPullRequest size={12} />
            Open
          </span>
          <span className="text-mock-fg-muted">getpaseo/paseo</span>
        </div>
      </div>

      <div className="flex items-center gap-[11px] bg-mock-surface1 px-[16px] py-[11px]">
        <CheckGlyph />
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-medium text-mock-fg">All checks have passed</span>
          <span className="block text-[11px] text-mock-fg-muted">
            9 successful, 13 skipped checks
          </span>
        </span>
        <ChevronDown size={14} className="text-mock-fg-muted" />
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="flex items-center gap-[6px] px-[16px] pt-[11px] pb-[4px] text-[11.5px] text-mock-fg-muted">
          9 successful checks
          <ChevronDown size={12} />
        </div>
        {CHECKS.map((check) => (
          <div key={check.name} className="flex items-center gap-[9px] px-[16px] py-[5px]">
            <CheckGlyph />
            <span className="shrink-0 truncate text-[12.5px] text-mock-fg">{check.name}</span>
            <span className="text-[11px] text-mock-fg-muted">{check.context}</span>
            <span className="flex-1" />
            <span className="shrink-0 text-[11px] tabular-nums text-mock-fg-muted">
              {check.time}
            </span>
          </div>
        ))}
        <div className="flex items-center gap-[6px] px-[16px] pt-[13px] pb-[4px] text-[11.5px] text-mock-fg-muted">
          <ChevronDown size={12} />
          Activity
        </div>
        <div className="px-[16px] pt-[2px] text-[12px] text-mock-fg-muted">No activity yet</div>
      </div>
    </PanelShell>
  );
}

// --- Plugins (invented custom dashboard) ------------------------------------
// No real reference exists; this reads as a user-built native surface plugin.

const PLUGIN_TABS: PanelTab[] = [
  ...CHANGES_TABS,
  { label: "Release Radar", icon: <Puzzle size={12} /> },
];

const TILES: { label: string; value: string; tile: string }[] = [
  { label: "Merged · 7d", value: "12", tile: "text-mock-tile-teal" },
  { label: "In review", value: "4", tile: "text-mock-tile-amber" },
  { label: "Failing", value: "1", tile: "text-mock-tile-red" },
];

// Weekly merge counts — a small bar chart the plugin author drew. Heights and
// their style objects are precomputed so the render loop allocates nothing.
const BARS: { id: string; style: { height: string } }[] = [
  { id: "mon", style: { height: "35px" } },
  { id: "tue", style: { height: "17px" } },
  { id: "wed", style: { height: "44px" } },
  { id: "thu", style: { height: "26px" } },
  { id: "fri", style: { height: "53px" } },
  { id: "sat", style: { height: "35px" } },
  { id: "sun", style: { height: "62px" } },
];

const RECENT: { title: string; meta: string; tone: string }[] = [
  {
    title: "Connect to remote daemons over SSH",
    meta: "#3989 · 20m ago",
    tone: "bg-mock-dot-success",
  },
  {
    title: "Keep restored workspaces out of loops",
    meta: "#3987 · 1h ago",
    tone: "bg-mock-dot-success",
  },
  {
    title: "Honor configured commit signing",
    meta: "#3976 · reviewing",
    tone: "bg-mock-dot-warning",
  },
];

function PluginDashboard() {
  return (
    <PanelShell tabs={PLUGIN_TABS} active={3}>
      <div
        className="flex shrink-0 items-center gap-[8px] border-b border-mock-border px-[16px]"
        style={SUBHEADER_STYLE}
      >
        <Puzzle size={14} className="text-mock-accent-bright" />
        <span className="text-[13px] font-medium text-mock-fg">Release Radar</span>
        <span className="text-[11px] text-mock-fg-muted">plugin</span>
        <span className="flex-1" />
        <RefreshCw size={13} className="text-mock-fg-muted" />
      </div>

      <div className="min-h-0 flex-1 overflow-hidden px-[16px] pt-[14px]">
        <div className="flex gap-[9px]">
          {TILES.map((tile) => (
            <div
              key={tile.label}
              className="flex-1 rounded-[10px] border border-mock-border-accent bg-mock-surface1 px-[12px] py-[11px]"
            >
              <div className={`text-[22px] leading-[24px] font-semibold tabular-nums ${tile.tile}`}>
                {tile.value}
              </div>
              <div className="pt-[3px] text-[10.5px] text-mock-fg-muted">{tile.label}</div>
            </div>
          ))}
        </div>

        <div className="mt-[16px] rounded-[10px] border border-mock-border-accent bg-mock-surface1 px-[14px] pt-[12px] pb-[13px]">
          <div className="flex items-center justify-between text-[11px] text-mock-fg-muted">
            <span>Merges · last 7 days</span>
            <span className="flex items-center gap-[5px] text-mock-tile-teal">
              <Rows3 size={11} />
              +18%
            </span>
          </div>
          <div className="flex h-[62px] items-end gap-[8px] pt-[12px]">
            {BARS.map((bar) => (
              <span
                key={bar.id}
                className="flex-1 rounded-[3px] bg-mock-accent-bright/70"
                style={bar.style}
              />
            ))}
          </div>
        </div>

        <div className="mt-[16px] text-[11px] text-mock-fg-muted">Recently merged</div>
        <div className="pt-[6px]">
          {RECENT.map((item) => (
            <div key={item.title} className="flex items-center gap-[10px] py-[7px]">
              <span className={`size-[7px] shrink-0 rounded-full ${item.tone}`} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] leading-[16px] text-mock-fg">
                  {item.title}
                </span>
                <span className="block text-[10.5px] leading-[13px] text-mock-fg-muted">
                  {item.meta}
                </span>
              </span>
            </div>
          ))}
        </div>
      </div>
    </PanelShell>
  );
}

export function RightPanel({ state }: { state: MockupStateId }) {
  if (state === "ship") return <ShipPanel />;
  if (state === "extend") return <PluginDashboard />;
  return <ChangesPanel />;
}
