import {
  ChevronDown,
  Columns2,
  Ellipsis,
  FileDiff,
  GitCommitHorizontal,
  Globe,
  PanelRight,
  Play,
  Plus,
  SquareTerminal,
} from "lucide-react";
import type * as React from "react";
import finderIconUrl from "../../../../app/assets/images/editor-apps/finder.png";
import { TABBAR_H, TITLEBAR_H } from "./geometry";
import { ClaudeIcon, CodexIcon, GithubGlyph } from "./icons";
import { hasRightPanel, type MockupStateId } from "./states";

const TITLEBAR_STYLE = { height: TITLEBAR_H };
const TABBAR_STYLE = { height: TABBAR_H };

/** A bordered toolbar button — the real header buttons carry an outline. */
function HeaderButton({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex h-[28px] items-center gap-[6px] rounded-[7px] border border-mock-border-accent bg-mock-surface1 px-[8px] text-[12px] text-mock-fg">
      {children}
    </span>
  );
}

function FinderSplitButton() {
  return (
    <span className="flex h-[28px] items-center overflow-hidden rounded-[7px] border border-mock-border-accent bg-mock-surface1 text-mock-fg-muted">
      <span className="flex h-full items-center px-[8px]">
        <img src={finderIconUrl} alt="" className="size-[16px]" />
      </span>
      <span className="h-full w-px bg-mock-border-accent" />
      <span className="flex h-full items-center px-[7px]">
        <ChevronDown size={12} />
      </span>
    </span>
  );
}

export function TitleBar({ state }: { state: MockupStateId }) {
  const shipping = state === "ship";
  return (
    <div
      className="flex shrink-0 items-center gap-[10px] border-b border-mock-border px-[16px]"
      style={TITLEBAR_STYLE}
    >
      <span className="truncate text-[13.5px] font-medium text-mock-fg">Paseo homepage</span>
      <span className="truncate text-[12.5px] text-mock-fg-muted">paseo</span>
      <Ellipsis size={14} className="shrink-0 text-mock-fg-muted" />

      <span className="flex-1" />

      <HeaderButton>
        <Play size={12} className="text-mock-fg-muted" />
        <ChevronDown size={12} className="text-mock-fg-muted" />
      </HeaderButton>
      <FinderSplitButton />
      <HeaderButton>
        {shipping ? (
          <>
            <GithubGlyph size={13} />
            Merge PR (squash)
          </>
        ) : (
          <>
            <GitCommitHorizontal size={14} className="text-mock-fg-muted" />
            Commit
          </>
        )}
        <ChevronDown size={12} className="text-mock-fg-muted" />
      </HeaderButton>
      {!hasRightPanel(state) ? (
        <span className="flex size-[26px] items-center justify-center text-mock-fg-muted">
          <PanelRight size={14} />
        </span>
      ) : null}
    </div>
  );
}

interface Tab {
  id: string;
  label: string;
  icon: React.ReactNode;
}

const WORKSPACE_TABS: Tab[] = [
  { id: "codex", label: "Codex", icon: <CodexIcon size={11} /> },
  { id: "claude", label: "Claude Code", icon: <ClaudeIcon size={11} /> },
  {
    id: "terminal",
    label: "npm run dev",
    icon: <SquareTerminal size={11} />,
  },
  {
    id: "browser",
    label: "https://localhost:3000",
    icon: <Globe size={11} />,
  },
];

const DIFF_TAB: Tab = { id: "diff", label: "Diff", icon: <FileDiff size={11} /> };

export function TabStrip({ state }: { state: MockupStateId }) {
  const review = state === "review";
  const tabs = review ? [...WORKSPACE_TABS, DIFF_TAB] : WORKSPACE_TABS;
  return (
    <div
      className="flex shrink-0 items-center gap-[5px] border-b border-mock-border pr-[16px] pl-[7px]"
      style={TABBAR_STYLE}
    >
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`flex items-center gap-[7px] rounded-[7px] px-[10px] py-[5px] ${
            (review ? tab.id === "diff" : tab.id === "codex")
              ? "bg-mock-surface2 text-mock-fg"
              : "text-mock-fg-muted"
          }`}
        >
          <span>{tab.icon}</span>
          <span className="whitespace-nowrap text-[11.5px]">{tab.label}</span>
        </div>
      ))}
      <span className="flex size-[22px] items-center justify-center text-mock-fg-muted">
        <Plus size={13} />
      </span>
      <span className="flex-1" />
      <span className="flex items-center gap-[14px] text-mock-fg-muted">
        <Columns2 size={13} />
        <Ellipsis size={14} />
      </span>
    </div>
  );
}
