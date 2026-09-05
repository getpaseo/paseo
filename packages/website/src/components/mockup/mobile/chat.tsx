// Mobile agent chat — the counterpart of the desktop chat pane, drawn at phone
// width. Maps to the "agent chat" reference screenshot: header, collapsed slash
// command, muted tool-call rows, an assistant turn, the diff-stat pill, and the
// composer. Presentational only; colors come from the `--color-mock-*` tokens.

import {
  AudioLines,
  ChevronDown,
  Copy,
  LoaderCircle,
  Menu,
  Mic,
  MoreHorizontal,
  PanelRight,
  Play,
  Plus,
  Server,
  Split,
  SquareTerminal,
} from "lucide-react";
import type * as React from "react";
import { CodexIcon } from "../icons";

const TOOL_ROWS = [
  "sed -n '321,680p' docs/release.md",
  '"for p in highlight relay protocol client plu…',
  "npx eas workflow:view 01a0493d-01cd-77…",
  "gh release view v0.7.0-beta.2 --json name…",
  "gh run list --commit 4e60c2880b4c9ebd…",
  "docker buildx imagetools inspect ghcr.io/g…",
];

function Header() {
  return (
    <div className="flex shrink-0 items-center gap-[14px] px-[18px] pt-[6px] pb-[12px]">
      <Menu size={22} className="shrink-0 text-mock-fg" strokeWidth={1.9} />
      <span className="min-w-0 flex-1">
        <span className="block text-[18px] font-semibold leading-[21px] text-mock-fg">Paseo</span>
        <span className="mt-[2px] flex items-center gap-[5px] text-[13px] leading-[16px] text-mock-fg-muted">
          <span className="shrink-0">paseo ·</span>
          <Server size={12} className="shrink-0" />
          <span className="truncate">Mohameds-MacBook-Pro.l…</span>
        </span>
      </span>
      <span className="flex shrink-0 items-center gap-[17px] text-mock-fg-muted">
        <MoreHorizontal size={20} />
        <Play size={19} strokeWidth={1.8} />
        <PanelRight size={19} strokeWidth={1.8} />
      </span>
    </div>
  );
}

function SlashRow() {
  return (
    <div className="flex shrink-0 items-center gap-[11px] border-y border-mock-border px-[18px] py-[13px]">
      <CodexIcon size={19} className="shrink-0 text-mock-fg" />
      <span className="flex-1 text-[17px] text-mock-fg">/release-beta</span>
      <ChevronDown size={19} className="shrink-0 text-mock-fg-muted" />
    </div>
  );
}

function ToolRow({ command }: { command: string }) {
  return (
    <div className="flex items-center gap-[13px] py-[7px] text-mock-fg-muted">
      <SquareTerminal size={19} className="shrink-0" strokeWidth={1.7} />
      <span className="shrink-0 text-[16px]">Shell</span>
      <span className="min-w-0 flex-1 truncate text-[16px]">{command}</span>
    </div>
  );
}

function InlineCode({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded-[4px] bg-mock-surface2 px-[5px] py-[1px] font-mono text-[13.5px] text-mock-fg">
      {children}
    </code>
  );
}

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-[12px] text-[16.5px] leading-[24px] text-mock-fg">
      <span className="text-mock-fg-muted">•</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  );
}

function Transcript() {
  return (
    <div className="px-[18px]">
      {TOOL_ROWS.map((command) => (
        <ToolRow key={command} command={command} />
      ))}
      <div className="my-[14px] h-px bg-mock-border" />
      <p className="text-[16.5px] leading-[24px] text-mock-fg">Still in progress:</p>
      <div className="mt-[14px] space-y-[7px]">
        <Bullet>npm tags and release notes are correct</Bullet>
        <Bullet>
          Docker beta image is published; <InlineCode>latest</InlineCode> remains unchanged
        </Bullet>
        <Bullet>iOS build succeeded; TestFlight distribution/Beta App Review is running</Bullet>
        <Bullet>Desktop and Android assets are still building</Bullet>
      </div>
      <p className="mt-[14px] text-[16.5px] leading-[24px] text-mock-fg">
        The heartbeat remains active.
      </p>
      <div className="flex items-center gap-[20px] pt-[16px] text-mock-fg-muted">
        <Copy size={18} strokeWidth={1.8} />
        <Split size={18} strokeWidth={1.8} />
      </div>
    </div>
  );
}

function Composer() {
  return (
    <div className="shrink-0 px-[18px] pt-[10px] pb-[30px]">
      <div className="mb-[16px]">
        <span className="inline-flex items-center gap-[6px] rounded-full border border-mock-border-accent px-[13px] py-[6px] text-[15px] tabular-nums">
          <span className="text-mock-success">+2,173</span>
          <span className="text-mock-danger">-54</span>
        </span>
      </div>
      <div className="rounded-[22px] border border-mock-border-accent bg-mock-surface1 px-[17px] pt-[15px] pb-[13px]">
        <span className="block text-[16px] text-mock-fg-xmuted">Message, @files, /commands</span>
        <div className="flex items-center gap-[13px] pt-[26px]">
          <Plus size={20} className="shrink-0 text-mock-fg-muted" strokeWidth={1.9} />
          <span className="flex shrink-0 items-center gap-[5px]">
            <CodexIcon size={19} className="shrink-0 text-mock-fg" />
            <span className="whitespace-nowrap text-[16px] text-mock-fg">GPT-5.6-Sol</span>
            <span className="whitespace-nowrap text-[16px] text-mock-fg-muted">Medium</span>
          </span>
          <span className="flex-1" />
          <LoaderCircle size={19} className="shrink-0 text-mock-fg-muted" strokeWidth={1.8} />
          <Mic size={19} className="shrink-0 text-mock-fg-muted" strokeWidth={1.8} />
          <AudioLines size={19} className="shrink-0 text-mock-fg-muted" strokeWidth={1.8} />
        </div>
      </div>
    </div>
  );
}

export function MobileChat() {
  return (
    <>
      <Header />
      <SlashRow />
      <div className="min-h-0 flex-1 overflow-hidden pt-[6px]">
        <Transcript />
      </div>
      <Composer />
    </>
  );
}
