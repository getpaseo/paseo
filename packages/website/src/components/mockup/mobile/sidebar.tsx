// Mobile workspace drawer — counterpart of the desktop sidebar. Maps to the
// "sidebar" reference screenshot: the New workspace / History / Schedules nav,
// the Pinned project list with identity tiles, and the Workspaces list split
// into Working and Done groups. Colors come from the `--color-mock-*` tokens.

import {
  CalendarClock,
  CircleCheck,
  CircleDot,
  CircleHelp,
  Columns2,
  GitPullRequest,
  History,
  House,
  Plus,
  Search,
  Server,
  Settings,
  Settings2,
  SquarePlus,
  X,
} from "lucide-react";
import type * as React from "react";
import { LetterTile, PaseoTile } from "./atoms";

// Icons passed as props are hoisted so they are not rebuilt on every render.
const NEW_WORKSPACE_ICON = <Plus size={19} strokeWidth={2} />;
const NEW_WORKSPACE_CLOSE = <X size={20} className="text-mock-fg-muted" strokeWidth={1.9} />;
const HISTORY_ICON = <History size={19} strokeWidth={1.8} />;
const SCHEDULES_ICON = <CalendarClock size={19} strokeWidth={1.8} />;
const WORKING_ICON = <CircleDot size={19} className="text-mock-dot-running" strokeWidth={1.9} />;
const READY_ICON = <CircleCheck size={19} className="text-mock-success" strokeWidth={1.9} />;
const DONE_ICON = <CircleCheck size={19} className="text-mock-fg-muted" strokeWidth={1.9} />;

function NavRow({
  icon,
  label,
  trailing,
}: {
  icon: React.ReactNode;
  label: string;
  trailing?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-[14px] px-[20px] py-[11px]">
      <span className="text-mock-fg-muted">{icon}</span>
      <span className="flex-1 text-[17px] text-mock-fg">{label}</span>
      {trailing}
    </div>
  );
}

interface RowData {
  key: string;
  icon: React.ReactNode;
  title: string;
  time: string;
  host?: string;
  pr?: string;
  passed?: boolean;
  selected?: boolean;
}

/** The workspace project icon — the same filled tile as the pinned rows, with
 * an optional running dot. Uses PaseoTile so pinned and workspace icons match. */
function WorkspaceGlyph({ running, white }: { running?: boolean; white?: boolean }) {
  return (
    <span className="relative flex size-[18px] items-center justify-center">
      {white ? <span className="size-[18px] rounded-[5px] bg-mock-fg" /> : <PaseoTile />}
      {running ? (
        <span className="absolute -right-[1px] -bottom-[1px] size-[7px] rounded-full border-[1.5px] border-mock-surface0 bg-mock-dot-running" />
      ) : null}
    </span>
  );
}

function BlankPageGlyph({ running }: { running?: boolean }) {
  return (
    <span className="relative flex size-[18px] items-center justify-center">
      <img src="/blank-page.svg" alt="" className="size-[18px]" />
      {running ? (
        <span className="absolute -right-[1px] -bottom-[1px] size-[7px] rounded-full border-[1.5px] border-mock-surface0 bg-mock-dot-running" />
      ) : null}
    </span>
  );
}

function WorkspaceMeta({ host, pr, passed }: Pick<RowData, "host" | "pr" | "passed">) {
  if (!host && !pr) return null;
  return (
    <span className="mt-[3px] flex items-center gap-[6px] text-[12.5px] text-mock-fg-muted">
      {host ? (
        <span className="flex items-center gap-[4px] text-mock-host-teal">
          <Server size={12} />
          {host}
        </span>
      ) : null}
      {host && pr ? <span className="text-mock-fg-xmuted">·</span> : null}
      {pr ? (
        <span className="flex items-center gap-[4px] tabular-nums">
          <GitPullRequest size={12} />
          {pr}
        </span>
      ) : null}
      {passed ? (
        <>
          <span className="text-mock-fg-xmuted">·</span>
          <span className="flex items-center gap-[4px] text-mock-success">
            <CircleCheck size={13} />
            passed
          </span>
        </>
      ) : null}
    </span>
  );
}

const PINNED: RowData[] = [
  {
    key: "skills-dotfiles",
    icon: <LetterTile letter="S" tone="red" />,
    title: "skills / dotfiles",
    time: "1h",
  },
];

const WORKING: RowData[] = [
  {
    key: "safe-area",
    icon: <WorkspaceGlyph running />,
    title: "Fix commit safe area in emulators",
    time: "4m",
  },
  {
    key: "blank-page-typing",
    icon: <BlankPageGlyph running />,
    title: "Improve editor typing latency",
    time: "18m",
  },
];

const READY: RowData[] = [
  {
    key: "paseo-homepage",
    icon: <WorkspaceGlyph />,
    title: "Paseo homepage",
    time: "now",
    pr: "3981",
    passed: true,
    selected: true,
  },
  {
    key: "blank-page-titles",
    icon: <BlankPageGlyph />,
    title: "Add automatic page titles",
    time: "12m",
    pr: "761",
    passed: true,
  },
];

const DONE: RowData[] = [
  {
    key: "beta",
    icon: <WorkspaceGlyph />,
    title: "Release v0.7.0-beta.2",
    time: "2h",
  },
  {
    key: "blank-page-focus",
    icon: <BlankPageGlyph />,
    title: "Preserve focus between pages",
    time: "3h",
    pr: "750",
    passed: true,
  },
  {
    key: "permissions",
    icon: <WorkspaceGlyph />,
    title: "Design semantic permission sy…",
    time: "7h",
    host: "my-server",
    pr: "3981",
    passed: true,
  },
  {
    key: "modules",
    icon: <WorkspaceGlyph />,
    title: "Plan modules and abstractions",
    time: "1d",
    pr: "3884",
    passed: true,
  },
  { key: "resume", icon: <WorkspaceGlyph />, title: "Resume in-progress work", time: "3d" },
  { key: "undefined", icon: <WorkspaceGlyph />, title: "Undefined task", time: "3d" },
  {
    key: "diagnose",
    icon: <WorkspaceGlyph />,
    title: "Diagnose cloud/Codex issue re…",
    time: "4d",
  },
  {
    key: "create-workspace",
    icon: <WorkspaceGlyph />,
    title: "Diagnose create_workspace 37…",
    time: "4d",
  },
  { key: "taps", icon: <WorkspaceGlyph />, title: "Diagnose tap interactions", time: "4d" },
  { key: "clarify", icon: <WorkspaceGlyph />, title: "Clarify task requirements", time: "5d" },
  { key: "abc", icon: <WorkspaceGlyph />, title: "Task for abcdefghi", time: "5d" },
];

/** One row — every pinned project and every workspace renders through this. */
function Row({
  icon,
  title,
  time,
  host,
  pr,
  passed,
  selected,
  indented = false,
}: RowData & { indented?: boolean }) {
  return (
    <div
      className={`flex items-center gap-[12px] rounded-[10px] py-[9px] pr-[12px] ${
        indented ? "pl-[24px]" : "pl-[12px]"
      } ${selected ? "bg-mock-surface1 ring-1 ring-mock-border-accent" : ""}`}
    >
      <span className="flex size-[18px] shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[16px] leading-[20px] text-mock-fg">{title}</span>
        <WorkspaceMeta host={host} pr={pr} passed={passed} />
      </span>
      <span className="shrink-0 self-start pt-[2px] text-[13px] text-mock-fg-xmuted">{time}</span>
    </div>
  );
}

function GroupHeader({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="flex items-center gap-[11px] px-[20px] pt-[16px] pb-[8px]">
      {icon}
      <span className="text-[15px] text-mock-fg-muted">{label}</span>
    </div>
  );
}

export function MobileSidebar() {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-mock-sidebar">
      <div className="pt-[4px]">
        <NavRow icon={NEW_WORKSPACE_ICON} label="New workspace" trailing={NEW_WORKSPACE_CLOSE} />
        <NavRow icon={HISTORY_ICON} label="History" />
        <NavRow icon={SCHEDULES_ICON} label="Schedules" />
      </div>

      <div className="mt-[4px] h-px bg-mock-border" />

      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="px-[20px] pt-[16px] pb-[6px] text-[15px] text-mock-fg-muted">Pinned</div>

        <div className="px-[8px]">
          {PINNED.map(({ key, ...row }) => (
            <Row key={key} {...row} />
          ))}
        </div>

        <div className="flex items-center px-[20px] pt-[26px] pb-[2px]">
          <span className="flex-1 text-[15px] text-mock-fg-muted">Workspaces</span>
          <span className="flex items-center gap-[18px] text-mock-fg-muted">
            <Search size={15} strokeWidth={1.8} />
            <Settings2 size={15} strokeWidth={1.8} />
          </span>
        </div>

        <GroupHeader icon={READY_ICON} label="Ready to review" />
        <div className="px-[8px]">
          {READY.map(({ key, ...row }) => (
            <Row key={key} {...row} indented />
          ))}
        </div>

        <GroupHeader icon={WORKING_ICON} label="Working" />
        <div className="px-[8px]">
          {WORKING.map(({ key, ...row }) => (
            <Row key={key} {...row} indented />
          ))}
        </div>

        <GroupHeader icon={DONE_ICON} label="Done" />
        <div className="px-[8px]">
          {DONE.map(({ key, ...row }) => (
            <Row key={key} {...row} indented />
          ))}
        </div>
      </div>

      <div className="h-px shrink-0 bg-mock-border" />
      <div className="flex h-[64px] shrink-0 items-center px-[20px] pb-[16px] text-mock-fg-muted">
        <span className="flex flex-1 items-center gap-[10px] text-[16px] text-mock-fg">
          <SquarePlus size={19} strokeWidth={1.8} />
          Add project
        </span>
        <span className="flex items-center gap-[22px]">
          <Columns2 size={20} strokeWidth={1.8} />
          <House size={20} strokeWidth={1.8} />
          <CircleHelp size={21} strokeWidth={1.8} />
          <Settings size={20} strokeWidth={1.8} />
        </span>
      </div>
    </div>
  );
}
