import * as React from "react";
import { motion } from "framer-motion";
import {
  FolderGit2,
  Paperclip,
  ArrowUp,
  X,
  MessagesSquare,
  Plus,
  Settings,
  Monitor,
  GitCommitHorizontal,
  ChevronDown,
  ChevronRight,
  ListChevronsUpDown,
  Bot,
  Check,
  Loader,
  SquareTerminal,
  PanelLeft,
  Ellipsis,
  Mic,
  GitPullRequest,
  SquarePen,
  Columns2,
  Rows2,
} from "lucide-react";
import { ClaudeIcon, CodexIcon, SourceControlIcon } from "~/components/mockup";

// ── Stagger timing ──────────────────────────────────────

const D = {
  shell: 0,
  sidebar: 0.1,
  titleBar: 0.15,
  tabs: 0.25,
  chat: 0.35,
  diffPanel: 0.55,
};

function fade(delay: number) {
  return {
    initial: { opacity: 0, y: 8 } as const,
    animate: { opacity: 1, y: 0 } as const,
    transition: { duration: 0.5, delay, ease: "easeOut" as const },
  };
}

// ── Data ────────────────────────────────────────────────

type ChatItem =
  | { type: "user"; text: string }
  | { type: "text"; text: string; bold?: boolean }
  | { type: "tool"; label: string; summary?: string; status: "running" | "done" };

const CHAT: ChatItem[] = [
  { type: "user", text: "Build me an internal dashboard for tracking customer returns" },
  { type: "text", text: "I'll break this down into planning and implementation.", bold: true },
  { type: "tool", label: "Run plan-technical", summary: "codex · plan-technical", status: "done" },
  { type: "tool", label: "Run plan-design", summary: "claude · plan-design", status: "done" },
  {
    type: "tool",
    label: "Wait for agents",
    summary: "plan-technical  plan-design",
    status: "done",
  },
  { type: "text", text: "Got the plans. Spinning up Codex for implementation.", bold: true },
  { type: "tool", label: "Run implement", summary: "codex · 12 files changed", status: "done" },
  { type: "text", text: "Implementation done. Requesting review from Claude." },
  { type: "tool", label: "Run review", summary: "claude · no issues found", status: "running" },
  { type: "text", text: "All tasks complete. Dashboard is ready.", bold: true },
];

// ── Sidebar data ────────────────────────────────────────

type SidebarWorkspace = {
  name: string;
  kind: "checkout" | "worktree";
  status: "running" | "done" | "idle" | "syncing";
  selected?: boolean;
  diffStat?: { additions: number; deletions: number };
  pr?: { number: number; state: "open" | "merged" | "closed" };
};

type SidebarProject = {
  initial: string;
  name: string;
  workspaces: SidebarWorkspace[];
};

const SIDEBAR_PROJECTS: SidebarProject[] = [
  {
    initial: "A",
    name: "acme/returns-app",
    workspaces: [
      {
        name: "main",
        kind: "checkout",
        status: "syncing",
        selected: true,
        diffStat: { additions: 247, deletions: 15 },
      },
      {
        name: "feat/dashboard",
        kind: "worktree",
        status: "done",
        pr: { number: 142, state: "open" },
      },
    ],
  },
  {
    initial: "P",
    name: "acme/payments",
    workspaces: [
      { name: "main", kind: "checkout", status: "idle" },
      {
        name: "fix/stripe-webhook",
        kind: "worktree",
        status: "done",
        diffStat: { additions: 38, deletions: 4 },
        pr: { number: 89, state: "merged" },
      },
    ],
  },
  {
    initial: "I",
    name: "acme/infra",
    workspaces: [
      { name: "main", kind: "checkout", status: "idle" },
      {
        name: "feat/k8s-autoscale",
        kind: "worktree",
        status: "syncing",
        diffStat: { additions: 91, deletions: 3 },
      },
    ],
  },
  {
    initial: "D",
    name: "acme/design-system",
    workspaces: [{ name: "main", kind: "checkout", status: "idle" }],
  },
];

// ── Tab data ─────────────────────────────────────────────

type TabDef = {
  name: string;
  provider: "claude" | "codex" | "terminal";
  done: boolean;
  active?: boolean;
};

const TABS: TabDef[] = [
  { name: "Orchestrator", provider: "claude", done: false, active: true },
  { name: "Implement", provider: "codex", done: true },
  { name: "Review", provider: "claude", done: true },
];

// ── Diff data ──────────────────────────────────────────

type DiffLineType = "add" | "remove" | "context" | "header";
type DiffLine = {
  type: DiffLineType;
  ln: string | null;
  content?: string;
  tokens?: Array<{ text: string; cls: string }>;
};

const DIFF_LINES: DiffLine[] = [
  {
    type: "add",
    ln: "1",
    tokens: [
      { text: "import", cls: "text-syn-keyword" },
      { text: " { ", cls: "text-syn-punctuation" },
      { text: "useState", cls: "text-syn-variable" },
      { text: " } ", cls: "text-syn-punctuation" },
      { text: "from", cls: "text-syn-keyword" },
      { text: ' "react"', cls: "text-syn-string" },
    ],
  },
  {
    type: "add",
    ln: "2",
    tokens: [
      { text: "import", cls: "text-syn-keyword" },
      { text: " { ", cls: "text-syn-punctuation" },
      { text: "ReturnTable", cls: "text-syn-variable" },
      { text: " } ", cls: "text-syn-punctuation" },
      { text: "from", cls: "text-syn-keyword" },
      { text: ' "./components"', cls: "text-syn-string" },
    ],
  },
  { type: "add", ln: "3", tokens: [] },
  {
    type: "add",
    ln: "4",
    tokens: [
      { text: "export", cls: "text-syn-keyword" },
      { text: " function", cls: "text-syn-keyword" },
      { text: " Dashboard", cls: "text-syn-function" },
      { text: "() {", cls: "text-syn-punctuation" },
    ],
  },
  {
    type: "add",
    ln: "5",
    tokens: [
      { text: "  const", cls: "text-syn-keyword" },
      { text: " [returns, setReturns]", cls: "text-syn-variable" },
      { text: " = ", cls: "text-syn-operator" },
      { text: "useState", cls: "text-syn-function" },
      { text: "([])", cls: "text-syn-punctuation" },
    ],
  },
  {
    type: "add",
    ln: "6",
    tokens: [
      { text: "  const", cls: "text-syn-keyword" },
      { text: " [filter, setFilter]", cls: "text-syn-variable" },
      { text: " = ", cls: "text-syn-operator" },
      { text: "useState", cls: "text-syn-function" },
      { text: '("all")', cls: "text-syn-string" },
    ],
  },
  { type: "add", ln: "7", tokens: [] },
  {
    type: "add",
    ln: "8",
    tokens: [
      { text: "  ", cls: "text-syn-punctuation" },
      { text: "return", cls: "text-syn-keyword" },
      { text: " (", cls: "text-syn-punctuation" },
    ],
  },
  {
    type: "add",
    ln: "9",
    tokens: [
      { text: "    <", cls: "text-syn-punctuation" },
      { text: "main", cls: "text-syn-tag" },
      { text: " className", cls: "text-syn-property" },
      { text: '="', cls: "text-syn-punctuation" },
      { text: "min-h-screen p-8", cls: "text-syn-string" },
      { text: '">', cls: "text-syn-punctuation" },
    ],
  },
  {
    type: "add",
    ln: "10",
    tokens: [
      { text: "      <", cls: "text-syn-punctuation" },
      { text: "h1", cls: "text-syn-tag" },
      { text: ">Customer Returns</", cls: "text-syn-variable" },
      { text: "h1", cls: "text-syn-tag" },
      { text: ">", cls: "text-syn-punctuation" },
    ],
  },
  {
    type: "add",
    ln: "11",
    tokens: [
      { text: "      <", cls: "text-syn-punctuation" },
      { text: "FilterBar", cls: "text-syn-tag" },
      { text: " value", cls: "text-syn-property" },
      { text: "={", cls: "text-syn-punctuation" },
      { text: "filter", cls: "text-syn-variable" },
      { text: "}", cls: "text-syn-punctuation" },
      { text: " onChange", cls: "text-syn-property" },
      { text: "={", cls: "text-syn-punctuation" },
      { text: "setFilter", cls: "text-syn-variable" },
      { text: "} />", cls: "text-syn-punctuation" },
    ],
  },
  {
    type: "add",
    ln: "12",
    tokens: [
      { text: "      <", cls: "text-syn-punctuation" },
      { text: "ReturnTable", cls: "text-syn-tag" },
      { text: " data", cls: "text-syn-property" },
      { text: "={", cls: "text-syn-punctuation" },
      { text: "returns", cls: "text-syn-variable" },
      { text: "} />", cls: "text-syn-punctuation" },
    ],
  },
  {
    type: "add",
    ln: "13",
    tokens: [
      { text: "      <", cls: "text-syn-punctuation" },
      { text: "StatusChart", cls: "text-syn-tag" },
      { text: " data", cls: "text-syn-property" },
      { text: "={", cls: "text-syn-punctuation" },
      { text: "returns", cls: "text-syn-variable" },
      { text: "} />", cls: "text-syn-punctuation" },
    ],
  },
  {
    type: "add",
    ln: "14",
    tokens: [
      { text: "    </", cls: "text-syn-punctuation" },
      { text: "main", cls: "text-syn-tag" },
      { text: ">", cls: "text-syn-punctuation" },
    ],
  },
  { type: "add", ln: "15", tokens: [{ text: "  )", cls: "text-syn-punctuation" }] },
  { type: "add", ln: "16", tokens: [{ text: "}", cls: "text-syn-punctuation" }] },
];

// ── Implementation agent chat data ──────────────────────

const IMPLEMENT_CHAT: ChatItem[] = [
  { type: "text", text: "Starting implementation of the returns dashboard.", bold: true },
  { type: "tool", label: "Edit file", summary: "src/pages/dashboard.tsx", status: "done" },
  { type: "tool", label: "Edit file", summary: "src/components/return-table.tsx", status: "done" },
  { type: "tool", label: "Edit file", summary: "src/components/filter-bar.tsx", status: "done" },
  { type: "tool", label: "Edit file", summary: "src/components/status-chart.tsx", status: "done" },
  { type: "tool", label: "Run command", summary: "npm run typecheck", status: "done" },
  { type: "text", text: "Typecheck passes. Adding API route and data fetching." },
  { type: "tool", label: "Edit file", summary: "src/api/returns.ts", status: "done" },
  { type: "tool", label: "Edit file", summary: "src/hooks/use-returns.ts", status: "done" },
  { type: "tool", label: "Run command", summary: "npm run typecheck", status: "running" },
];

// ── Terminal log lines ─────────────────────────────────

const TERMINAL_LINES = [
  { text: "$ npm run dev", cls: "text-mock-fg" },
  { text: "", cls: "" },
  { text: "> acme-returns@0.1.0 dev", cls: "text-mock-fg-muted" },
  { text: "> next dev --turbopack", cls: "text-mock-fg-muted" },
  { text: "", cls: "" },
  { text: "  ▲ Next.js 15.3.1 (Turbopack)", cls: "text-mock-fg" },
  { text: "  - Local:   http://localhost:3000", cls: "text-mock-fg-muted" },
  { text: "", cls: "" },
  { text: " ✓ Starting...", cls: "text-mock-green" },
  { text: " ✓ Ready in 1.2s", cls: "text-mock-green" },
  { text: " ○ Compiling /dashboard ...", cls: "text-mock-fg-muted" },
  { text: " ✓ Compiled /dashboard in 340ms", cls: "text-mock-green" },
  { text: " ○ Compiling /api/returns ...", cls: "text-mock-fg-muted" },
  { text: " ✓ Compiled /api/returns in 120ms", cls: "text-mock-green" },
];

// ── Sub-components ──────────────────────────────────────

function TrafficLights() {
  return (
    <div className="flex items-center gap-[6px]">
      <div className="w-[11px] h-[11px] rounded-full bg-[#ff5f57]" />
      <div className="w-[11px] h-[11px] rounded-full bg-[#febc2e]" />
      <div className="w-[11px] h-[11px] rounded-full bg-[#28c840]" />
    </div>
  );
}

function ProviderIcon({
  provider,
  muted = false,
}: {
  provider: "claude" | "codex" | "terminal";
  muted?: boolean;
}) {
  const cls = muted ? "text-mock-fg-muted" : "text-mock-fg";
  if (provider === "terminal") return <SquareTerminal size={13} className={cls} />;
  return provider === "claude" ? (
    <ClaudeIcon size={13} className={cls} />
  ) : (
    <CodexIcon size={13} className={cls} />
  );
}

function TabBarAction({
  icon: Icon,
}: {
  icon: React.ComponentType<{ size?: number; className?: string; strokeWidth?: number }>;
}) {
  return (
    <div className="w-4 h-5 flex items-center justify-center flex-shrink-0">
      <Icon size={12} strokeWidth={1.5} className="text-mock-fg-muted" />
    </div>
  );
}

function PaneTabBar({ tabs, focused = false }: { tabs: TabDef[]; focused?: boolean }) {
  return (
    <div className="flex items-stretch h-7 bg-mock-surface0 border-b border-mock-border flex-shrink-0">
      {tabs.map((tab) => (
        <div
          key={tab.name}
          className="flex items-center gap-1.5 px-2 border-r border-mock-border relative min-w-0"
        >
          {tab.active && (
            <div
              className={`absolute top-0 left-0 right-0 h-0.5 ${focused ? "bg-mock-accent" : "bg-mock-border-accent"}`}
            />
          )}

          <div className="relative flex-shrink-0">
            <ProviderIcon provider={tab.provider} muted={!tab.active} />
          </div>

          <span
            className={`text-[11px] truncate ${tab.active ? "text-mock-fg" : "text-mock-fg-muted"}`}
          >
            {tab.name}
          </span>

          <X size={11} className="text-mock-zinc500 flex-shrink-0 ml-auto" />
        </div>
      ))}
      <div className="ml-auto flex items-center px-1.5">
        <TabBarAction icon={SquarePen} />
        <TabBarAction icon={SquareTerminal} />
        <TabBarAction icon={Columns2} />
        <TabBarAction icon={Rows2} />
      </div>
    </div>
  );
}

function Composer({
  provider,
  model,
  focused = false,
}: {
  provider: "claude" | "codex";
  model: string;
  focused?: boolean;
}) {
  const Icon = provider === "claude" ? ClaudeIcon : CodexIcon;
  return (
    <div className="px-3 pb-3 flex-shrink-0">
      <div className="bg-mock-surface1 border border-mock-border-accent rounded-2xl px-3 py-2 flex flex-col gap-[10px]">
        <div className="flex items-center">
          {focused && (
            <span className="inline-block w-[1px] h-[13px] bg-mock-fg animate-pulse mr-[1px] flex-shrink-0" />
          )}
          <span className="text-[11px] text-mock-zinc500 leading-[1.4] select-none whitespace-nowrap overflow-hidden text-ellipsis">
            Message the agent, tag @files, or use /commands and /skills
          </span>
        </div>
        <div className="flex items-end justify-between">
          <div className="flex items-center gap-0.5">
            <div className="w-[22px] h-[22px] rounded-full flex items-center justify-center flex-shrink-0">
              <Paperclip size={12} className="text-mock-fg" />
            </div>
            <div className="flex items-center gap-[4px] h-[22px] px-[6px] rounded-full">
              <Icon size={12} className="text-mock-fg-muted" />
              <span className="text-[10px] text-mock-fg-muted leading-none">{model}</span>
              <ChevronDown size={10} className="text-mock-fg-muted" />
            </div>
          </div>
          <div className="flex items-center gap-[6px]">
            <div className="w-[22px] h-[22px] rounded-full flex items-center justify-center flex-shrink-0">
              <Mic size={12} className="text-mock-fg" />
            </div>
            <div className="w-[22px] h-[22px] rounded-full bg-mock-accent flex items-center justify-center flex-shrink-0">
              <ArrowUp size={12} className="text-white" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ChatMessages({ items }: { items: ChatItem[] }) {
  return (
    <div className="flex-1 overflow-hidden px-2 py-2">
      {items.map((item, i) => {
        if (item.type === "user") {
          return (
            <div key={i} className="flex justify-end py-1">
              <div
                className="bg-mock-surface2 px-2.5 py-1.5 max-w-[85%] leading-none"
                style={{ borderRadius: "16px 2px 16px 16px" }}
              >
                <span className="text-[11px] text-mock-fg leading-none">{item.text}</span>
              </div>
            </div>
          );
        }
        if (item.type === "tool") {
          const isDone = item.status === "done";
          return (
            <div
              key={i}
              className="flex items-center rounded-lg px-2 py-[1px] -mx-[6px] border border-transparent"
            >
              <div className="w-[22px] h-[22px] rounded-full flex items-center justify-center flex-shrink-0 mr-1">
                <Bot size={12} className="text-mock-fg-muted" />
              </div>
              <span className="text-[11px] text-mock-fg-muted truncate flex-shrink-0">
                {item.label}
              </span>
              {item.summary && (
                <span className="text-[11px] text-mock-zinc500 truncate flex-1 ml-2">
                  {item.summary}
                </span>
              )}
              <div className="ml-auto flex-shrink-0 pl-2">
                {isDone ? (
                  <Check size={11} className="text-mock-zinc500" />
                ) : (
                  <Loader size={11} className="text-mock-fg-muted animate-spin" />
                )}
              </div>
            </div>
          );
        }
        return (
          <p
            key={i}
            className={`text-[11px] px-2 py-[1px] text-mock-fg leading-[1.5] ${item.bold ? "font-medium" : ""}`}
          >
            {item.text}
          </p>
        );
      })}
    </div>
  );
}

function ChatArea() {
  return (
    <div className="flex flex-col flex-1 min-w-0 bg-mock-surface0">
      <ChatMessages items={CHAT} />
      <Composer provider="claude" model="Opus 4.6" focused />
    </div>
  );
}

function ImplementPane() {
  return (
    <div className="flex flex-col flex-1 min-w-0 min-h-0 bg-mock-surface0">
      <ChatMessages items={IMPLEMENT_CHAT} />
      <Composer provider="codex" model="gpt-5.4" />
    </div>
  );
}

function TerminalPane() {
  return (
    <div className="flex flex-col flex-1 min-w-0 min-h-0 bg-mock-surface0">
      <div className="flex-1 overflow-hidden px-3 py-2">
        {TERMINAL_LINES.map((line, i) => (
          <div key={i} className="leading-[1.3]">
            <code className={`text-[10px] font-mono ${line.cls} whitespace-pre`}>{line.text}</code>
          </div>
        ))}
      </div>
    </div>
  );
}

function ExplorerSidebar() {
  return (
    <div className="flex flex-col bg-mock-sidebar border-l border-mock-border w-[28%] flex-shrink-0 overflow-hidden">
      {/* Explorer header — h-12, Changes/Files tabs */}
      <div className="flex items-center h-10 px-2 border-b border-mock-border flex-shrink-0">
        <div className="flex items-center gap-1">
          <div className="flex items-center px-3 py-1.5 rounded-md bg-mock-surface1">
            <span className="text-[11px] text-mock-fg font-medium">Changes</span>
          </div>
          <div className="flex items-center px-3 py-1.5 rounded-md">
            <span className="text-[11px] text-mock-fg-muted">Files</span>
          </div>
        </div>
      </div>

      {/* Secondary header — h-9, Uncommitted dropdown + filter icons */}
      <div className="flex items-center justify-between h-9 border-b border-mock-border flex-shrink-0">
        <div className="flex items-center gap-1 ml-2 px-1 h-6 rounded">
          <span className="text-[11px] text-mock-fg-muted">Uncommitted</span>
          <ChevronDown size={11} className="text-mock-fg-muted" />
        </div>
        <div className="flex items-center pr-2">
          <div className="flex items-center justify-center w-6 h-6 rounded">
            <ListChevronsUpDown size={14} className="text-mock-fg-muted" />
          </div>
        </div>
      </div>

      {/* File header — expanded */}
      <div className="flex items-center justify-between pl-2 pr-2 py-1.5 border-b border-mock-border flex-shrink-0">
        <div className="flex items-center gap-1 flex-1 min-w-0 overflow-hidden">
          <ChevronDown size={10} className="text-mock-fg-muted flex-shrink-0" />
          <span className="text-[11px] text-mock-fg flex-shrink-0">dashboard.tsx</span>
          <span className="text-[11px] text-mock-fg-muted truncate min-w-0"> src/pages</span>
          <span
            className="text-[10px] text-mock-green-400 px-2 py-[2px] rounded-md flex-shrink-0"
            style={{ backgroundColor: "rgba(46, 160, 67, 0.2)" }}
          >
            New
          </span>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0 ml-1">
          <span className="text-[11px] text-mock-green-400">+16</span>
          <span className="text-[11px] text-mock-red">-0</span>
        </div>
      </div>

      {/* Diff lines */}
      <div className="overflow-hidden bg-mock-surface1">
        {DIFF_LINES.map((line, i) => {
          const isAdd = line.type === "add";
          const isRemove = line.type === "remove";
          const lineBg = isAdd
            ? "bg-mock-diff-add"
            : isRemove
              ? "bg-mock-diff-remove"
              : "bg-mock-surface1";
          const lineNumCls = isAdd
            ? "text-mock-green-400"
            : isRemove
              ? "text-mock-red"
              : "text-mock-fg-muted";

          return (
            <div key={i} className={`flex items-stretch ${lineBg}`}>
              <div className="w-8 border-r border-mock-border flex-shrink-0 flex items-center justify-end">
                <code className={`text-[10px] font-mono ${lineNumCls} select-none pr-2 py-[1px]`}>
                  {line.ln ?? ""}
                </code>
              </div>
              <code className="text-[10px] font-mono text-mock-fg pl-3 pr-3 py-[1px] whitespace-pre flex-1 min-w-0">
                {line.tokens?.map((tok, j) => (
                  <span key={j} className={tok.cls}>
                    {tok.text}
                  </span>
                ))}
              </code>
            </div>
          );
        })}
      </div>

      {/* Collapsed file rows */}
      {[
        { name: "return-table.tsx", dir: "src/components", added: 42, removed: 8 },
        { name: "filter-bar.tsx", dir: "src/components", added: 28, removed: 3 },
        { name: "status-chart.tsx", dir: "src/components", added: 19, removed: 0, isNew: true },
        { name: "returns.ts", dir: "src/api", added: 12, removed: 5 },
        { name: "index.tsx", dir: "src/pages", added: 6, removed: 2 },
      ].map((file) => (
        <div
          key={file.name}
          className="flex items-center justify-between pl-2 pr-2 py-1.5 border-b border-mock-border"
        >
          <div className="flex items-center gap-1 flex-1 min-w-0 overflow-hidden">
            <ChevronRight size={10} className="text-mock-fg-muted flex-shrink-0" />
            <span className="text-[11px] text-mock-fg flex-shrink-0">{file.name}</span>
            <span className="text-[11px] text-mock-fg-muted truncate min-w-0"> {file.dir}</span>
            {file.isNew && (
              <span
                className="text-[10px] text-mock-green-400 px-2 py-[2px] rounded-md flex-shrink-0"
                style={{ backgroundColor: "rgba(46, 160, 67, 0.2)" }}
              >
                New
              </span>
            )}
          </div>
          <div className="flex items-center gap-1 flex-shrink-0 ml-1">
            <span className="text-[11px] text-mock-green-400">+{file.added}</span>
            <span className="text-[11px] text-mock-red">-{file.removed}</span>
          </div>
        </div>
      ))}

      <div className="flex-1" />
    </div>
  );
}

// Snake traversal order matching the real app: [0, 1, 3, 5, 4, 2] (2-col × 3-row grid)
// DOT_SEQUENCE[sequenceIndex] = dotIndex, so sequenceIndex = indexOf(dotIndex)
const DOT_SEQUENCE = [0, 1, 3, 5, 4, 2] as const;
const SYNCED_LOADER_DURATION_MS = 950;
const DOT_COUNT = 6;
const STEP_MS = SYNCED_LOADER_DURATION_MS / DOT_COUNT; // 158.333…ms per step

function SyncedLoader({ size = 11 }: { size?: number }) {
  const gap = Math.max(1, Math.round(size * 0.12));
  const dotSize = Math.max(2, Math.floor((size - gap * 2) / 3));
  const gridW = dotSize * 2 + gap;
  const gridH = dotSize * 3 + gap * 2;

  return (
    <div
      style={{
        width: size,
        height: size,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      <div style={{ position: "relative", width: gridW, height: gridH }}>
        {Array.from({ length: DOT_COUNT }).map((_, dotIndex) => {
          const col = dotIndex % 2;
          const row = Math.floor(dotIndex / 2);
          // The snake sequence index for this dot: when is it the "head"?
          const sequenceIndex = DOT_SEQUENCE.indexOf(dotIndex as (typeof DOT_SEQUENCE)[number]);
          // Negative delay syncs the animation so this dot is the head at t=0 when sequenceIndex=0.
          // At t=0, headIndex should be 0, meaning sequenceIndex=0 dot is the head.
          // Each dot is shifted by sequenceIndex steps back in time.
          const delayMs = -(sequenceIndex * STEP_MS);
          return (
            <div
              key={dotIndex}
              style={{
                position: "absolute",
                left: col * (dotSize + gap),
                top: row * (dotSize + gap),
                width: dotSize,
                height: dotSize,
                borderRadius: "50%",
                backgroundColor: "#f59e0b",
                animationName: "synced-snake-dot",
                animationDuration: `${SYNCED_LOADER_DURATION_MS}ms`,
                animationTimingFunction: "linear",
                animationIterationCount: "infinite",
                animationDelay: `${delayMs}ms`,
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

function WorkspaceStatusDot({ status }: { status: SidebarWorkspace["status"] }) {
  if (status === "running") return <div className="w-[5px] h-[5px] rounded-full bg-mock-amber" />;
  if (status === "done") return <div className="w-[5px] h-[5px] rounded-full bg-mock-green" />;
  return null;
}

function Sidebar() {
  // Shared left edge: pl-3 (12px) for traffic lights, icons, footer dot
  // Workspace indent: pl-7 (28px)
  // PR badge aligns with workspace text: pl-[42px]
  return (
    <div className="flex flex-col bg-mock-sidebar border-r border-mock-border w-[200px] flex-shrink-0">
      {/* Traffic lights */}
      <div className="flex items-center pl-3 pr-2 pt-3 pb-2">
        <TrafficLights />
      </div>

      {/* Sessions header */}
      <div className="flex items-center gap-2 pl-3 pr-2 py-2 border-b border-mock-border">
        <MessagesSquare size={16} className="text-mock-fg-muted flex-shrink-0" />
        <span className="text-sm text-mock-fg-muted">Sessions</span>
      </div>

      {/* Project list */}
      <div className="flex-1 overflow-hidden pt-1 pb-4 min-h-0">
        {SIDEBAR_PROJECTS.map((project) => (
          <div key={project.name} className="mb-2">
            {/* Project row — icon aligns with traffic lights / sessions */}
            <div className="flex items-center gap-2 min-h-[32px] py-1.5 pl-3 pr-2">
              <div className="w-4 h-4 rounded-sm border border-mock-border flex items-center justify-center flex-shrink-0">
                <span className="text-[9px] text-mock-fg-muted leading-none">
                  {project.initial}
                </span>
              </div>
              <span className="text-[13px] text-mock-fg font-normal truncate flex-1 min-w-0 leading-5">
                {project.name}
              </span>
            </div>

            {/* Workspace rows — indented one level */}
            {project.workspaces.map((workspace) => (
              <div
                key={workspace.name}
                className={`mb-1 mx-1.5 rounded-lg ${workspace.selected ? "bg-mock-surface1" : ""}`}
              >
                <div className="flex items-center gap-2 min-h-[28px] py-1 pl-[22px] pr-1">
                  <div className="relative w-[14px] h-4 flex-shrink-0 flex items-center justify-center">
                    {workspace.status === "syncing" ? (
                      <SyncedLoader size={11} />
                    ) : (
                      <>
                        {workspace.kind === "worktree" ? (
                          <FolderGit2 size={14} className="text-mock-fg-muted" />
                        ) : (
                          <Monitor size={14} className="text-mock-fg-muted" />
                        )}
                        {workspace.status !== "idle" && (
                          <div className="absolute bottom-0 right-0">
                            <WorkspaceStatusDot status={workspace.status} />
                          </div>
                        )}
                      </>
                    )}
                  </div>
                  <span className="text-[12px] text-mock-fg/[0.76] font-normal truncate flex-1 min-w-0 leading-[1.4]">
                    {workspace.name}
                  </span>
                  {workspace.diffStat && (
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <span className="text-[10px] text-mock-green-400 font-normal leading-none">
                        +{workspace.diffStat.additions}
                      </span>
                      <span className="text-[10px] text-mock-red font-normal leading-none">
                        -{workspace.diffStat.deletions}
                      </span>
                    </div>
                  )}
                </div>
                {workspace.pr && (
                  <div className="flex items-center gap-1 pl-[42px] pr-2 pb-0.5">
                    <GitPullRequest size={11} className="text-mock-fg-muted" />
                    <span className="text-[10px] text-mock-fg-muted leading-none truncate">
                      #{workspace.pr.number} ·{" "}
                      {workspace.pr.state === "open"
                        ? "Open"
                        : workspace.pr.state === "merged"
                          ? "Merged"
                          : "Closed"}
                    </span>
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* Footer — dot aligns with traffic lights / icons */}
      <div className="flex items-center justify-between pl-3 pr-2 py-3 border-t border-mock-border">
        <div className="flex items-center gap-2 min-w-0 flex-shrink">
          <div className="w-2 h-2 rounded-full bg-mock-green flex-shrink-0" />
          <span className="text-[13px] text-mock-fg-muted truncate">MacBook Pro</span>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <div className="w-6 h-6 flex items-center justify-center">
            <Plus size={18} className="text-mock-fg-muted" />
          </div>
          <div className="w-6 h-6 flex items-center justify-center">
            <Settings size={18} className="text-mock-fg-muted" />
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Desktop Mockup ──────────────────────────────────────

function DesktopMockup() {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [scale, setScale] = React.useState(1);

  React.useEffect(() => {
    function updateScale() {
      if (!containerRef.current) return;
      const parentWidth = containerRef.current.parentElement?.clientWidth ?? 1200;
      const designWidth = 1200;
      setScale(Math.min(1, parentWidth / designWidth));
    }
    updateScale();
    window.addEventListener("resize", updateScale);
    return () => window.removeEventListener("resize", updateScale);
  }, []);

  return (
    <div
      ref={containerRef}
      className="w-full overflow-hidden"
      style={{ height: `${1200 * (9 / 16) * scale}px` }}
    >
      <div
        className="mx-auto rounded-xl overflow-hidden border border-mock-border bg-mock-surface0 shadow-[6px_6px_0_rgba(0,0,0,0.4)] origin-top-left"
        style={{ width: 1200, transform: `scale(${scale})` }}
      >
        {/* Top-level: left sidebar | center column | explorer sidebar — all full height */}
        <div className="flex aspect-video">
          {/* Left sidebar — full height */}
          <motion.div {...fade(D.sidebar)} className="contents">
            <Sidebar />
          </motion.div>

          {/* Center column: title bar + split panes */}
          <div className="flex flex-col flex-1 min-w-0 min-h-0">
            {/* Title bar — belongs to center column only */}
            <motion.div
              {...fade(D.titleBar)}
              className="flex items-center h-10 px-2 bg-mock-surface0 border-b border-mock-border flex-shrink-0"
            >
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <div className="px-2 py-1 rounded-lg flex items-center justify-center flex-shrink-0">
                  <PanelLeft size={14} className="text-mock-fg-muted" />
                </div>
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <span className="text-[13px] font-light text-mock-fg truncate flex-shrink-0">
                    main
                  </span>
                  <span className="text-[13px] text-mock-fg-muted truncate flex-shrink min-w-0">
                    acme/returns-app
                  </span>
                  <div className="px-2 py-1 rounded-lg flex items-center justify-center flex-shrink-0">
                    <Ellipsis size={14} className="text-mock-fg-muted" />
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-2 ml-auto flex-shrink-0">
                <div className="flex items-stretch rounded-md border border-mock-border-accent overflow-hidden">
                  <div className="flex items-center gap-2 px-3 py-1">
                    <GitCommitHorizontal size={12} className="text-mock-fg-muted flex-shrink-0" />
                    <span className="text-[11px] text-mock-fg font-normal">Commit</span>
                  </div>
                  <div className="flex items-center justify-center w-7 border-l border-mock-border-accent">
                    <ChevronDown size={12} className="text-mock-fg-muted" />
                  </div>
                </div>
                <div className="flex items-center gap-2 px-3 py-1 rounded-md">
                  <SourceControlIcon size={14} className="text-mock-fg-muted" />
                  <span className="text-[11px] font-normal text-mock-green-400">+247</span>
                  <span className="text-[11px] font-normal text-mock-red">-15</span>
                </div>
              </div>
            </motion.div>

            {/* Split panes */}
            <div className="flex flex-1 min-h-0">
              {/* Left pane: all agent tabs + chat */}
              <div className="flex flex-col flex-1 min-w-0 min-h-0">
                <motion.div {...fade(D.tabs)}>
                  <PaneTabBar tabs={TABS} focused />
                </motion.div>
                <motion.div {...fade(D.chat)} className="flex-1 flex min-h-0">
                  <ChatArea />
                </motion.div>
              </div>

              {/* Resize handle */}
              <div className="w-px bg-mock-border flex-shrink-0" />

              {/* Right pane: terminal only */}
              <motion.div {...fade(D.chat)} className="flex flex-col flex-1 min-w-0 min-h-0">
                <PaneTabBar
                  tabs={[{ name: "npm run dev", provider: "terminal", done: false, active: true }]}
                />
                <TerminalPane />
              </motion.div>
            </div>
          </div>

          {/* Explorer sidebar — full height, pushes center column */}
          <motion.div {...fade(D.diffPanel)} className="contents">
            <ExplorerSidebar />
          </motion.div>
        </div>
      </div>
    </div>
  );
}

// ── Export ───────────────────────────────────────────────

export function HeroMockup() {
  return <DesktopMockup />;
}
