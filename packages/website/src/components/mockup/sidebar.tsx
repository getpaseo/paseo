import { AnimatePresence, motion } from "framer-motion";
import {
  CalendarClock,
  CircleCheck,
  CircleDot,
  CircleHelp,
  GitPullRequest,
  History,
  House,
  PanelBottom,
  PanelLeft,
  Plus,
  Puzzle,
  Search,
  Server,
  Settings,
  Settings2,
  SquarePlus,
} from "lucide-react";
import type * as React from "react";
import { SIDEBAR_W, TITLEBAR_H } from "./geometry";
import { PaseoMark } from "./icons";
import { FADE_IN, FADE_OUT } from "./motion";
import type { MockupStateId } from "./states";

const SIDEBAR_STYLE = { width: SIDEBAR_W };
const TITLEBAR_STYLE = { height: TITLEBAR_H };
const NAV_DEFAULT_LAYOUT = { height: 97 };
const NAV_EXTENDED_LAYOUT = { height: 127 };

// --- data -------------------------------------------------------------------

type Avatar =
  | { kind: "paseo" }
  | { kind: "blank-page" }
  | { kind: "tile"; letter: string; tile: string };

interface WorkspaceRow {
  id: string;
  title: string;
  avatar: Avatar;
  time: string;
  host?: string;
  pr?: string;
  passed?: boolean;
  running?: boolean;
  selected?: boolean;
}

const PASEO: Avatar = { kind: "paseo" };
const BLANK_PAGE: Avatar = { kind: "blank-page" };

const PINNED_ROWS: WorkspaceRow[] = [
  {
    id: "pin-skills-dotfiles",
    title: "skills / dotfiles",
    avatar: { kind: "tile", letter: "S", tile: "bg-mock-tile-red" },
    time: "1h",
  },
];

const WORKING_ROWS: WorkspaceRow[] = [
  {
    id: "safe-area",
    title: "Fix commit safe area in emulators",
    avatar: PASEO,
    time: "4m",
    running: true,
  },
  {
    id: "blank-page-typing",
    title: "Improve editor typing latency",
    avatar: BLANK_PAGE,
    time: "18m",
    running: true,
  },
];

const READY_TO_REVIEW_ROWS: WorkspaceRow[] = [
  {
    id: "lineage",
    title: "Paseo homepage",
    avatar: PASEO,
    pr: "3981",
    passed: true,
    time: "now",
    selected: true,
  },
  {
    id: "blank-page-titles",
    title: "Add automatic page titles",
    avatar: BLANK_PAGE,
    pr: "761",
    passed: true,
    time: "12m",
  },
];

const DONE_ROWS: WorkspaceRow[] = [
  { id: "beta", title: "Release v0.7.0-beta.2", avatar: PASEO, time: "2h" },
  {
    id: "blank-page-focus",
    title: "Preserve focus between pages",
    avatar: BLANK_PAGE,
    pr: "750",
    passed: true,
    time: "3h",
  },
  {
    id: "perms",
    title: "Design semantic permission sy…",
    avatar: PASEO,
    host: "my-server",
    pr: "3981",
    passed: true,
    time: "7h",
  },
  {
    id: "modules",
    title: "Plan modules and abstractions",
    avatar: PASEO,
    pr: "3884",
    passed: true,
    time: "1d",
  },
  { id: "resume", title: "Resume in-progress work", avatar: PASEO, time: "3d" },
  { id: "undef", title: "Undefined task", avatar: PASEO, time: "3d" },
  { id: "codex-issue", title: "Diagnose cloud/Codex issue re…", avatar: PASEO, time: "4d" },
  { id: "cws", title: "Diagnose create_workspace 37…", avatar: PASEO, time: "4d" },
  { id: "taps", title: "Diagnose tap interactions", avatar: PASEO, time: "4d" },
  { id: "clarify", title: "Clarify task requirements", avatar: PASEO, time: "5d" },
  { id: "abc", title: "Task for abcdefghi", avatar: PASEO, time: "5d" },
];

// --- pieces -----------------------------------------------------------------

// Icons passed as props are hoisted so they are not rebuilt on every render.
const NEW_WORKSPACE_ICON = <Plus size={14} />;
const HISTORY_ICON = <History size={14} />;
const SCHEDULES_ICON = <CalendarClock size={14} />;
const PLUGIN_ICON = <Puzzle size={14} />;
const WORKING_ICON = <CircleDot size={16} className="text-mock-dot-running" />;
const READY_TO_REVIEW_ICON = <CircleCheck size={16} className="text-mock-success" />;
const DONE_ICON = <CircleCheck size={16} className="text-mock-fg-xmuted" />;

function NavItem({
  icon,
  label,
  active,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
}) {
  return (
    <div
      className={`flex h-[30px] items-center gap-[10px] rounded-[7px] px-[10px] text-[12.5px] text-mock-fg ${
        active ? "bg-mock-surface1" : ""
      }`}
    >
      <span className="text-mock-fg-muted">{icon}</span>
      {label}
    </div>
  );
}

/** The rounded-square agent avatar, with a blue running dot on the corner. */
function AvatarIcon({ avatar }: { avatar: Avatar }) {
  if (avatar.kind === "paseo") {
    return (
      <span className="flex size-[16px] items-center justify-center rounded-[5px] bg-black text-white">
        <PaseoMark size={14} />
      </span>
    );
  }
  if (avatar.kind === "blank-page") {
    return <img src="/blank-page.svg" alt="" className="size-[16px]" />;
  }
  return (
    <span
      className={`flex size-[16px] items-center justify-center rounded-[5px] text-[9px] font-semibold text-white ${avatar.tile}`}
    >
      {avatar.letter}
    </span>
  );
}

function RowAvatar({ avatar, running }: { avatar: Avatar; running?: boolean }) {
  return (
    <span className="relative block size-[16px] shrink-0">
      <AvatarIcon avatar={avatar} />
      {running ? (
        <span className="absolute -right-[1px] -bottom-[1px] size-[6px] rounded-full bg-mock-dot-running ring-[1.5px] ring-mock-sidebar" />
      ) : null}
    </span>
  );
}

function RowMeta({ row }: { row: WorkspaceRow }) {
  if (row.host || row.pr) {
    return (
      <span className="mt-[3px] flex items-center gap-[6px] text-[10.5px] leading-[13px] text-mock-fg-muted">
        {row.host ? (
          <span className="flex items-center gap-[4px] text-mock-host-teal">
            <Server size={12} className="shrink-0" />
            {row.host}
          </span>
        ) : null}
        {row.host && row.pr ? <span className="text-mock-fg-xmuted">·</span> : null}
        {row.pr ? (
          <span className="flex items-center gap-[4px]">
            <GitPullRequest size={10} className="shrink-0" />
            {row.pr}
          </span>
        ) : null}
        {row.passed ? (
          <>
            <span className="text-mock-fg-xmuted">·</span>
            <span className="flex items-center gap-[4px] text-mock-success">
              <CircleCheck size={11} className="shrink-0" />
              passed
            </span>
          </>
        ) : null}
      </span>
    );
  }
  return null;
}

function Row({ row, indented = false }: { row: WorkspaceRow; indented?: boolean }) {
  return (
    <motion.div
      layout="position"
      className={`flex gap-[8px] rounded-[8px] py-[7px] pr-[9px] ${
        indented ? "pl-[21px]" : "pl-[9px]"
      } ${row.selected ? "bg-mock-surface1" : ""}`}
    >
      <span className="pt-[1px]">
        <RowAvatar avatar={row.avatar} running={row.running} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-[8px]">
          <span className="min-w-0 flex-1 truncate text-[13px] leading-[17px] text-mock-fg">
            {row.title}
          </span>
          <span className="shrink-0 text-[11px] text-mock-fg-xmuted">{row.time}</span>
        </span>
        <RowMeta row={row} />
      </span>
    </motion.div>
  );
}

function GroupHeader({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="mt-[10px] mb-[3px] flex items-center gap-[8px] px-[9px] py-[7px]">
      <span className="flex size-[16px] shrink-0 items-center justify-center">{icon}</span>
      <span className="text-[13px] leading-[17px] text-mock-fg-muted">{label}</span>
    </div>
  );
}

// --- sidebar ----------------------------------------------------------------

export function Sidebar({ state }: { state: MockupStateId }) {
  const extending = state === "extend";

  return (
    <div className="flex shrink-0 flex-col overflow-hidden bg-mock-sidebar" style={SIDEBAR_STYLE}>
      {/* The sidebar is one full-height column with no header border of its own. */}
      <div className="flex shrink-0 items-center gap-[8px] px-[18px]" style={TITLEBAR_STYLE}>
        <div className="flex h-[24px] items-center gap-[7px]">
          <i className="block size-[10px] rounded-full bg-[#ff5f57]" />
          <i className="block size-[10px] rounded-full bg-[#febc2e]" />
          <i className="block size-[10px] rounded-full bg-[#28c840]" />
        </div>
        <span className="flex size-[24px] shrink-0 items-center justify-center">
          <PanelLeftGlyph />
        </span>
      </div>

      <motion.div
        initial={false}
        animate={extending ? NAV_EXTENDED_LAYOUT : NAV_DEFAULT_LAYOUT}
        className="overflow-hidden px-[8px] pt-[7px]"
      >
        <NavItem icon={NEW_WORKSPACE_ICON} label="New workspace" />
        <NavItem icon={HISTORY_ICON} label="History" />
        <NavItem icon={SCHEDULES_ICON} label="Schedules" />
        <motion.div initial={false} animate={extending ? FADE_IN : FADE_OUT}>
          <NavItem icon={PLUGIN_ICON} label="Release Radar" active />
        </motion.div>
      </motion.div>

      <div className="mt-[9px] h-px bg-mock-border" />

      <div className="min-h-0 flex-1 overflow-hidden px-[8px]">
        <div className="px-[9px] pt-[8px] text-[11px] text-mock-fg-muted">Pinned</div>
        {PINNED_ROWS.map((row) => (
          <Row key={row.id} row={row} />
        ))}

        <div className="mt-[16px] flex items-center justify-between px-[9px] pb-[2px]">
          <span className="text-[11px] text-mock-fg-muted">Workspaces</span>
          <span className="flex items-center gap-[13px] text-mock-fg-muted">
            <Search size={11} className="text-mock-fg-muted" />
            <Settings2 size={11} className="text-mock-fg-muted" />
          </span>
        </div>

        <GroupHeader icon={READY_TO_REVIEW_ICON} label="Ready to review" />
        {READY_TO_REVIEW_ROWS.map((row) => (
          <Row key={row.id} row={row} indented />
        ))}

        <GroupHeader icon={WORKING_ICON} label="Working" />
        <AnimatePresence initial={false} mode="popLayout">
          {WORKING_ROWS.map((row) => (
            <motion.div key={row.id} layout initial={FADE_OUT} animate={FADE_IN} exit={FADE_OUT}>
              <Row row={row} indented />
            </motion.div>
          ))}
        </AnimatePresence>

        <GroupHeader icon={DONE_ICON} label="Done" />
        {DONE_ROWS.map((row) => (
          <Row key={row.id} row={row} indented />
        ))}
      </div>

      <div className="h-px shrink-0 bg-mock-border" />
      <div className="flex h-[44px] shrink-0 items-center gap-[8px] px-[14px] text-[12.5px] text-mock-fg-muted">
        <SquarePlus size={14} />
        <span className="text-mock-fg">Add project</span>
        <span className="flex-1" />
        <PanelBottom size={14} />
        <House size={14} />
        <CircleHelp size={14} />
        <Settings size={14} />
      </div>
    </div>
  );
}

function PanelLeftGlyph() {
  return <PanelLeft size={15} strokeWidth={1.8} className="translate-y-px text-mock-fg-muted" />;
}
