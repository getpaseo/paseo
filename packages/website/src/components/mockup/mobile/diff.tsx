// Mobile diff view — counterpart of the desktop diff pane. Maps to the "diff"
// reference screenshot: Changes/Files tabs, the branch + uncommitted scope rows,
// a new-file header, a hunk header, and the added lines of atoms.tsx (every row
// an addition, so the whole gutter runs green). Reuses the shared `Code`
// highlighter and the `--color-mock-diff-*` tokens.

import {
  ChevronDown,
  FileDiff,
  Files,
  GitBranch,
  GitPullRequest,
  MoreHorizontal,
  RefreshCw,
  SquareDot,
  X,
} from "lucide-react";
import { Code } from "../atoms";
import { ReactFileIcon } from "../icons";

type MobileDiffMark = "add" | "remove" | "context";

interface MobileDiffLine {
  n: number;
  text: string;
  mark: MobileDiffMark;
}

const ROW_COLOR: Record<MobileDiffMark, string> = {
  add: "bg-mock-diff-add",
  remove: "bg-mock-diff-remove",
  context: "",
};

const NUMBER_COLOR: Record<MobileDiffMark, string> = {
  add: "text-mock-success",
  remove: "text-mock-danger",
  context: "text-mock-fg-muted",
};

const DIFF_LINES: MobileDiffLine[] = [
  { n: 7, text: 'type DotTone = "success" | "danger" | "idle";', mark: "remove" },
  { n: 7, text: "export type DotTone =", mark: "add" },
  { n: 8, text: '  | "success"', mark: "add" },
  { n: 9, text: '  | "danger"', mark: "add" },
  { n: 10, text: '  | "warning"', mark: "add" },
  { n: 11, text: '  | "running"', mark: "add" },
  { n: 12, text: '  | "idle";', mark: "add" },
  { n: 13, text: "", mark: "context" },
  { n: 14, text: "interface DiffStatProps {", mark: "context" },
  { n: 15, text: "  add: string;", mark: "context" },
  { n: 16, text: "  remove: string;", mark: "context" },
  { n: 17, text: "}", mark: "context" },
  { n: 18, text: "", mark: "context" },
  { n: 19, text: "/** Compact diff summary. */", mark: "add" },
  { n: 20, text: "export function DiffStat({", mark: "add" },
  { n: 21, text: "  add,", mark: "add" },
  { n: 22, text: "  remove,", mark: "add" },
  { n: 23, text: "}: DiffStatProps) {", mark: "add" },
  { n: 24, text: "  return (", mark: "context" },
  { n: 25, text: '    <span className="flex gap-1">', mark: "remove" },
  { n: 25, text: '    <span className="flex gap-[4px]">', mark: "add" },
  { n: 26, text: '      <span className="text-mock-success">', mark: "context" },
  { n: 27, text: "        +{add}", mark: "context" },
  { n: 28, text: "      </span>", mark: "context" },
  { n: 29, text: '      <span className="text-mock-danger">', mark: "context" },
  { n: 30, text: "        -{remove}", mark: "context" },
  { n: 31, text: "      </span>", mark: "context" },
  { n: 32, text: "    </span>", mark: "context" },
  { n: 33, text: "  )", mark: "remove" },
  { n: 33, text: "  );", mark: "add" },
  { n: 34, text: "}", mark: "context" },
];

function Tabs() {
  return (
    <div className="flex shrink-0 items-center gap-[5px] px-[18px] pt-[4px] pb-[14px]">
      <span className="flex items-center gap-[7px] rounded-[8px] px-[10px] py-[6px] text-[16px] text-mock-fg-muted">
        <Files size={17} strokeWidth={1.8} />
        Files
      </span>
      <span className="flex items-center gap-[7px] rounded-[8px] bg-mock-surface2 px-[10px] py-[6px] text-[16px] text-mock-fg">
        <FileDiff size={17} strokeWidth={1.8} />
        Changes
      </span>
      <span className="flex items-center gap-[7px] rounded-[8px] px-[10px] py-[6px] text-[16px] text-mock-fg-muted tabular-nums">
        <GitPullRequest size={17} strokeWidth={1.8} />
        3981
      </span>
      <span className="flex-1" />
      <X size={22} className="text-mock-fg-muted" strokeWidth={1.9} />
    </div>
  );
}

function BranchRow() {
  return (
    <div className="flex shrink-0 items-center border-t border-mock-border px-[18px] py-[11px]">
      <span className="flex items-center gap-[6px] text-[16px] text-mock-fg">
        main
        <ChevronDown size={16} className="text-mock-fg-muted" />
      </span>
      <span className="flex-1" />
      <span className="flex items-center gap-[6px] rounded-[8px] border border-mock-border-accent px-[10px] py-[5px] text-mock-fg-muted">
        <GitBranch size={15} />
        <ChevronDown size={14} />
      </span>
    </div>
  );
}

function ScopeRow() {
  return (
    <div className="flex shrink-0 items-center gap-[12px] border-y border-mock-border px-[18px] py-[11px]">
      <span className="flex items-center gap-[5px] text-[16px] text-mock-fg">
        Uncommitted
        <ChevronDown size={16} className="text-mock-fg-muted" />
      </span>
      <span className="flex items-center gap-[6px] text-[15px] tabular-nums">
        <span className="text-mock-success">+2,173</span>
        <span className="text-mock-danger">-54</span>
      </span>
      <span className="flex-1" />
      <span className="flex items-center gap-[15px] text-mock-fg-muted">
        <RefreshCw size={17} strokeWidth={1.8} />
        <MoreHorizontal size={19} />
      </span>
    </div>
  );
}

function FileHeader() {
  return (
    <div className="flex shrink-0 items-center gap-[9px] px-[18px] py-[11px]">
      <ReactFileIcon size={15} />
      <span className="shrink-0 text-[16px] text-mock-fg">atoms.tsx</span>
      <span className="min-w-0 flex-1 truncate text-[14px] text-mock-fg-muted">
        packages/website/src/componen…
      </span>
      <span className="flex shrink-0 items-center gap-[3px] text-[14px] tabular-nums">
        <span className="text-mock-success">+56</span>
        <span className="text-mock-danger">-18</span>
      </span>
      <SquareDot size={17} className="shrink-0 text-mock-warning" strokeWidth={1.7} />
    </div>
  );
}

function DiffLine({ n, text, mark }: MobileDiffLine) {
  const comment = text.trimStart().startsWith("/") || text.trimStart().startsWith("*");
  return (
    <div className={`flex items-center ${ROW_COLOR[mark]}`} style={ROW_STYLE}>
      <span
        className={`shrink-0 pr-[10px] text-right font-mono text-[13px] tabular-nums ${NUMBER_COLOR[mark]}`}
        style={GUTTER_STYLE}
      >
        {n}
      </span>
      <span className="min-w-0 flex-1 overflow-hidden whitespace-pre pl-[12px] font-mono text-[14px] leading-[26px]">
        {comment ? <span className="text-mock-fg-muted">{text}</span> : <Code line={text} />}
      </span>
    </div>
  );
}

const ROW_H = 26;
const GUTTER_W = 44;
const ROW_STYLE = { height: ROW_H };
const GUTTER_STYLE = { width: GUTTER_W };
const GUTTER_RULE_STYLE = { left: GUTTER_W };

export function MobileDiff() {
  return (
    <>
      <Tabs />
      <BranchRow />
      <ScopeRow />
      <FileHeader />
      <div className="relative min-h-0 flex-1 overflow-hidden bg-mock-surface1">
        <div
          className="pointer-events-none absolute top-0 bottom-0 w-px bg-mock-border"
          style={GUTTER_RULE_STYLE}
        />
        <div className="flex items-center bg-mock-surface-diff-empty" style={ROW_STYLE}>
          <span className="shrink-0" style={GUTTER_STYLE} />
          <span className="pl-[12px] font-mono text-[13px] text-mock-fg-muted">
            @@ -7,20 +7,28 @@
          </span>
        </div>
        {DIFF_LINES.map((line) => (
          <DiffLine key={`${line.n}-${line.mark}-${line.text}`} {...line} />
        ))}
      </div>
      <div className="flex h-[52px] shrink-0 items-center border-t border-mock-border px-[18px] pb-[16px] text-[16px] text-mock-fg">
        Commits
      </div>
    </>
  );
}
