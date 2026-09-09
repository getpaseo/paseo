import {
  ChevronDown,
  ChevronRight,
  Columns2,
  Ellipsis,
  List,
  Minus,
  Plus,
  RefreshCw,
  Rows3,
} from "lucide-react";
import { Code, DiffStat } from "./atoms";
import { TABBAR_H } from "./geometry";
import { ReactFileIcon } from "./icons";

// Row height and the gutter width are the two numbers that make a diff read as a
// diff. Everything else follows them.
const ROW_H = 18.5;
const HUNK_H = 23;
const GUTTER_W = 42;

const ROW_STYLE = { height: ROW_H };
const HUNK_STYLE = { height: HUNK_H };
const GUTTER_STYLE = { width: GUTTER_W };
const SCROLLBAR_ROW_STYLE = { height: 9 };
const SUBHEADER_STYLE = { height: TABBAR_H };

export type DiffRow =
  | { kind: "file"; name: string; path?: string; add: string; remove: string }
  | { kind: "hunk"; label: string }
  | { kind: "line"; n: string; text: string; mark?: DiffMark }
  | { kind: "scrollbar" }
  | { kind: "gap" };

type DiffMark = "add" | "remove";

// The row fill and the gutter number are the whole visual language of a diff:
// status hue at low alpha behind the row, full status hue on the number.
const ROW_FILL: Record<DiffMark, string> = {
  add: "bg-mock-diff-add",
  remove: "bg-mock-diff-remove",
};

const NUMBER_COLOR: Record<DiffMark, string> = {
  add: "text-mock-success",
  remove: "text-mock-danger",
};

function DiffLine({ n, text, mark }: { n: string; text: string; mark?: DiffMark }) {
  const fill = mark ? ROW_FILL[mark] : "";
  const number = mark ? NUMBER_COLOR[mark] : "text-mock-fg-muted";
  return (
    <div className={`flex items-center ${fill}`} style={ROW_STYLE}>
      <span
        className={`flex h-full shrink-0 items-center justify-end border-r border-mock-border pr-[10px] font-mono text-[11px] tabular-nums ${number}`}
        style={GUTTER_STYLE}
      >
        {n}
      </span>
      <span className="min-w-0 flex-1 overflow-hidden whitespace-pre pl-[10px] font-mono text-[12px] leading-[18.5px]">
        <Code line={text} />
      </span>
    </div>
  );
}

function FileRow({
  name,
  path,
  add,
  remove,
}: {
  name: string;
  path?: string;
  add: string;
  remove: string;
}) {
  return (
    <div className="flex h-[36px] items-center gap-[8px] border-b border-mock-border bg-mock-surface0 pr-[14px] pl-[16px]">
      <ChangesFileIcon name={name} />
      <span className="min-w-0 flex-1 truncate text-[12px]">
        <span className="text-mock-fg">{name}</span>
        {path ? <span className="ml-[6px] text-mock-fg-muted">{path}</span> : null}
      </span>
      <DiffStat add={add} remove={remove} />
    </div>
  );
}

export function DiffRows({ rows, flush }: { rows: DiffRow[]; flush?: boolean }) {
  return (
    <div className={`relative overflow-hidden bg-mock-surface1 ${flush ? "" : "min-h-0 flex-1"}`}>
      {rows.map((row, index) => {
        const key = `${row.kind}-${index}`;
        if (row.kind === "file") return <FileRow key={key} {...row} />;
        if (row.kind === "scrollbar")
          return (
            <div key={key} className="flex items-center pl-[46px]" style={SCROLLBAR_ROW_STYLE}>
              <span className="h-[5px] w-[110px] rounded-full bg-mock-surface4" />
            </div>
          );
        if (row.kind === "gap") return <div key={key} style={ROW_STYLE} />;
        if (row.kind === "hunk")
          return (
            <div key={key} className="flex items-center" style={HUNK_STYLE}>
              <span className="h-full shrink-0 border-r border-mock-border" style={GUTTER_STYLE} />
              <span className="pl-[10px] font-mono text-[11px] text-mock-fg-muted">
                {row.label}
              </span>
            </div>
          );
        return <DiffLine key={key} {...row} />;
      })}
      {!flush ? (
        <span className="pointer-events-none absolute top-[86px] right-[3px] bottom-[8px] w-[4px] rounded-full bg-mock-surface2">
          <span className="mt-[112px] block h-[92px] rounded-full bg-mock-surface4" />
        </span>
      ) : null}
    </div>
  );
}

/** The `Uncommitted ⌄` scope row with the view-mode controls on the right. */
export function ScopeRow({ label }: { label: string }) {
  return (
    <div className="flex h-[31px] shrink-0 items-center border-b border-mock-border px-[14px]">
      <span className="flex items-center gap-[5px] text-[12px] text-mock-fg">
        {label}
        <ChevronDown size={12} className="text-mock-fg-muted" />
      </span>
      <span className="flex-1" />
      <span className="flex items-center gap-[13px] text-mock-fg-muted">
        <Columns2 size={13} />
        <span className="rounded-[5px] bg-mock-surface2 p-[3px] text-mock-fg">
          <List size={12} />
        </span>
        <Rows3 size={13} />
        <ChevronDown size={12} />
      </span>
    </div>
  );
}

// --- flat diff tree ---------------------------------------------------------
// The default diff view is a flat file list: name · path · +N -M · expand box.

export interface TreeFile {
  name: string;
  path?: string;
  add: string;
  remove: string;
}

/** The expand affordance on a tree row — green + for pure additions, else a dot. */
function ExpandBox({ pure }: { pure: boolean }) {
  return (
    <span
      className={`flex size-[15px] shrink-0 items-center justify-center rounded-[4px] border ${
        pure
          ? "border-mock-success/60 text-mock-success"
          : "border-mock-warning/50 text-mock-warning"
      }`}
    >
      {pure ? (
        <Plus size={11} strokeWidth={2.4} />
      ) : (
        <i className="block size-[3px] rounded-full bg-current" />
      )}
    </span>
  );
}

/** One row of the flat diff tree. */
export function DiffTreeRow({ file }: { file: TreeFile }) {
  const pure = file.remove === "0";
  return (
    <div className="flex items-center gap-[10px] border-b border-mock-border px-[14px] py-[7px]">
      <span className="min-w-0 flex-1 truncate text-[12.5px]">
        <span className="text-mock-fg">{file.name}</span>
        {file.path ? <span className="text-mock-fg-muted"> {file.path}</span> : null}
      </span>
      <span className="flex shrink-0 items-center gap-[4px] text-[11px] tabular-nums">
        <span className="text-mock-success">+{file.add}</span>
        <span className={pure ? "text-mock-fg-xmuted" : "text-mock-danger"}>-{file.remove}</span>
      </span>
      <ExpandBox pure={pure} />
    </div>
  );
}

export function DiffTree({ files }: { files: TreeFile[] }) {
  return (
    <div className="min-h-0 flex-1 overflow-hidden">
      {files.map((file) => (
        <DiffTreeRow key={`${file.path ?? ""}/${file.name}`} file={file} />
      ))}
    </div>
  );
}

export const REVIEW_TREE: TreeFile[] = [
  { name: "providers.md", path: "docs", add: "3", remove: "1" },
  {
    name: "bridge-plugin.mjs",
    path: "packages/server/src/server/agent/providers/opencode",
    add: "146",
    remove: "0",
  },
  {
    name: "bridge.test.ts",
    path: "packages/server/src/server/agent/providers/opencode",
    add: "181",
    remove: "0",
  },
  {
    name: "bridge.ts",
    path: "packages/server/src/server/agent/providers/opencode",
    add: "284",
    remove: "0",
  },
  {
    name: "server-manager.ts",
    path: "packages/server/src/server/agent/providers/opencode",
    add: "13",
    remove: "1",
  },
  {
    name: "opencode-agent.test.ts",
    path: "packages/server/src/server/agent/providers",
    add: "40",
    remove: "0",
  },
  {
    name: "opencode-agent.ts",
    path: "packages/server/src/server/agent/providers",
    add: "58",
    remove: "8",
  },
  {
    name: "opencode-bridge-adapter.test.ts",
    path: "packages/server/src/server/agent/providers",
    add: "123",
    remove: "0",
  },
  {
    name: "opencode-bridge.local.e2e.test.ts",
    path: "packages/server/src/server/agent/providers",
    add: "158",
    remove: "0",
  },
  {
    name: "provider-registry.ts",
    path: "packages/server/src/server/agent",
    add: "10",
    remove: "2",
  },
  {
    name: "provider-snapshot-manager.ts",
    path: "packages/server/src/server/agent",
    add: "5",
    remove: "0",
  },
  { name: "bootstrap.ts", path: "packages/server/src/server", add: "12", remove: "0" },
  { name: "package.json", path: "packages/server", add: "2", remove: "1" },
  { name: "trace-daemon.mjs", path: "scripts", add: "2", remove: "0" },
  { name: "package-lock.json", add: "260", remove: "1" },
];

// --- explorer changes tree -------------------------------------------------

interface ChangesTreeFolder {
  kind: "folder";
  name: string;
  depth: ChangesTreeDepth;
  add: string;
  remove: string;
}

interface ChangesTreeFile {
  kind: "file";
  name: string;
  depth: ChangesTreeDepth;
  add: string;
  remove: string;
  status: ChangeStatus;
}

type ChangesTreeEntry = ChangesTreeFolder | ChangesTreeFile;
type ChangesTreeDepth = 0 | 1 | 2 | 3 | 4;
type ChangeStatus = "added" | "modified" | "deleted";

const CHANGES_TREE: ChangesTreeEntry[] = [
  { kind: "folder", name: "packages/website/src", depth: 0, add: "1.9k", remove: "684" },
  { kind: "folder", name: "components", depth: 1, add: "1.5k", remove: "512" },
  { kind: "folder", name: "mockup", depth: 2, add: "1.3k", remove: "389" },
  { kind: "folder", name: "mobile", depth: 3, add: "480", remove: "231" },
  { kind: "file", name: "atoms.tsx", depth: 4, add: "56", remove: "18", status: "modified" },
  { kind: "file", name: "chat.tsx", depth: 4, add: "155", remove: "74", status: "modified" },
  { kind: "file", name: "frame.tsx", depth: 4, add: "91", remove: "0", status: "added" },
  { kind: "file", name: "legacy-tabs.tsx", depth: 4, add: "0", remove: "139", status: "deleted" },
  { kind: "folder", name: "desktop", depth: 3, add: "612", remove: "143" },
  { kind: "file", name: "window.tsx", depth: 4, add: "167", remove: "42", status: "modified" },
  { kind: "file", name: "titlebar.tsx", depth: 4, add: "117", remove: "61", status: "modified" },
  { kind: "file", name: "toolbar.tsx", depth: 4, add: "204", remove: "0", status: "added" },
  { kind: "file", name: "old-tabs.tsx", depth: 4, add: "0", remove: "40", status: "deleted" },
  { kind: "folder", name: "shared", depth: 3, add: "194", remove: "15" },
  { kind: "file", name: "icons.tsx", depth: 4, add: "62", remove: "15", status: "modified" },
  { kind: "file", name: "geometry.ts", depth: 4, add: "17", remove: "0", status: "added" },
  { kind: "file", name: "states.ts", depth: 4, add: "115", remove: "0", status: "added" },
  { kind: "file", name: "hero-mockup.tsx", depth: 2, add: "89", remove: "52", status: "modified" },
  { kind: "folder", name: "routes", depth: 1, add: "211", remove: "96" },
  { kind: "file", name: "index.tsx", depth: 2, add: "44", remove: "70", status: "modified" },
  { kind: "file", name: "download.tsx", depth: 2, add: "167", remove: "0", status: "added" },
  { kind: "folder", name: "styles", depth: 1, add: "68", remove: "76" },
  { kind: "file", name: "mockup.css", depth: 2, add: "68", remove: "47", status: "modified" },
  { kind: "file", name: "legacy.css", depth: 2, add: "0", remove: "29", status: "deleted" },
];

/** The open workspace diff matches the selected file in the Changes tree. */
export const REVIEW_DIFF_ROWS: DiffRow[] = [
  {
    kind: "file",
    name: "chat.tsx",
    path: "packages/website/src/components/mockup/mobile",
    add: "155",
    remove: "74",
  },
  { kind: "hunk", label: "@@ -22,5 +23,11 @@" },
  { kind: "line", n: "22", text: "const TOOL_ROWS = [", mark: "remove" },
  {
    kind: "line",
    n: "23",
    text: 'type ToolKind = "read" | "shell";',
    mark: "add",
  },
  { kind: "line", n: "24", text: "" },
  {
    kind: "line",
    n: "25",
    text: "interface ToolCall {",
    mark: "add",
  },
  { kind: "line", n: "26", text: "  kind: ToolKind;", mark: "add" },
  { kind: "line", n: "27", text: "  label: string;", mark: "add" },
  { kind: "line", n: "28", text: "  command: string;", mark: "add" },
  { kind: "line", n: "29", text: "}", mark: "add" },
  { kind: "line", n: "30", text: "" },
  {
    kind: "line",
    n: "31",
    text: "const TOOL_CALLS: ToolCall[] = [",
    mark: "add",
  },
  { kind: "line", n: "32", text: "  {", mark: "add" },
  { kind: "line", n: "33", text: '    ...readToolCall("docs/design.md"),', mark: "add" },
  { kind: "line", n: "34", text: "  },", mark: "add" },
  { kind: "line", n: "35", text: "];", mark: "add" },
  { kind: "line", n: "36", text: "" },
  {
    kind: "file",
    name: "titlebar.tsx",
    path: "packages/website/src/components/mockup/desktop",
    add: "117",
    remove: "61",
  },
  { kind: "hunk", label: "@@ -88,6 +92,16 @@" },
  {
    kind: "line",
    n: "88",
    text: "const AGENT_TABS: Tab[] = [",
    mark: "remove",
  },
  {
    kind: "line",
    n: "92",
    text: "const WORKSPACE_TABS: Tab[] = [",
    mark: "add",
  },
  {
    kind: "line",
    n: "95",
    text: '  { id: "terminal", label: "npm run dev", icon: <SquareTerminal /> },',
    mark: "add",
  },
  {
    kind: "line",
    n: "96",
    text: '  { id: "browser", label: "https://localhost:3000", icon: <Globe /> },',
    mark: "add",
  },
  { kind: "line", n: "97", text: "];" },
  { kind: "line", n: "98", text: "" },
  {
    kind: "file",
    name: "window.tsx",
    path: "packages/website/src/components/mockup/desktop",
    add: "167",
    remove: "42",
  },
  { kind: "hunk", label: "@@ -118,7 +124,7 @@" },
  { kind: "line", n: "118", text: "      <TitleBar state={state} />" },
  { kind: "line", n: "119", text: "      <TabStrip />", mark: "remove" },
  { kind: "line", n: "124", text: "      <TabStrip state={state} />", mark: "add" },
  { kind: "line", n: "125", text: '      <div className="relative min-h-0 flex-1">' },
  { kind: "line", n: "126", text: "        <AnimatePresence initial={false}>" },
  {
    kind: "file",
    name: "mockup.css",
    path: "packages/website/src/styles",
    add: "68",
    remove: "47",
  },
  { kind: "hunk", label: "@@ -54,4 +61,4 @@" },
  {
    kind: "line",
    n: "54",
    text: "--color-mock-diff-add: rgba(108, 177, 123, 0.15);",
    mark: "remove",
  },
  {
    kind: "line",
    n: "61",
    text: "--color-mock-diff-add: rgba(108, 177, 123, 0.08);",
    mark: "add",
  },
  {
    kind: "line",
    n: "55",
    text: "--color-mock-diff-remove: rgba(216, 132, 123, 0.1);",
    mark: "remove",
  },
  {
    kind: "line",
    n: "62",
    text: "--color-mock-diff-remove: rgba(216, 132, 123, 0.07);",
    mark: "add",
  },
];

const TREE_DEPTH_PADDING = [
  "pl-[14px]",
  "pl-[27px]",
  "pl-[40px]",
  "pl-[53px]",
  "pl-[66px]",
] as const;

function ChangesFileIcon({ name }: { name: string }) {
  if (name.endsWith(".tsx")) return <ReactFileIcon size={13} />;
  const label = name.endsWith(".css") ? "CSS" : "TS";
  const color = name.endsWith(".css") ? "bg-purple-400/70" : "bg-sky-400/70";
  return (
    <span
      className={`flex h-[13px] w-[15px] shrink-0 items-center justify-center text-[6px] font-bold text-mock-surface0 ${color}`}
    >
      {label}
    </span>
  );
}

function ChangeStatusBox({ status }: { status: ChangeStatus }) {
  if (status === "added") return <ExpandBox pure />;
  const deleted = status === "deleted";
  return (
    <span
      className={`flex size-[15px] shrink-0 items-center justify-center rounded-[4px] border ${
        deleted
          ? "border-mock-danger/50 text-mock-danger"
          : "border-mock-warning/50 text-mock-warning"
      }`}
    >
      {deleted ? (
        <Minus size={11} strokeWidth={2.4} />
      ) : (
        <i className="block size-[3px] rounded-full bg-current" />
      )}
    </span>
  );
}

function ChangesTreeRow({ entry, selected }: { entry: ChangesTreeEntry; selected: boolean }) {
  const hasAdditions = entry.add !== "0";
  const hasRemovals = entry.remove !== "0";
  return (
    <div
      className={`flex h-[29px] items-center gap-[8px] pr-[10px] ${TREE_DEPTH_PADDING[entry.depth]} ${
        selected ? "bg-mock-surface2" : ""
      }`}
    >
      {entry.kind === "folder" ? (
        <ChevronDown size={13} className="shrink-0 text-mock-fg-muted" />
      ) : null}
      {entry.kind === "file" ? <ChangesFileIcon name={entry.name} /> : null}
      <span className="min-w-0 flex-1 truncate text-[12px] text-mock-fg">{entry.name}</span>
      <span className="flex shrink-0 items-center gap-[4px] text-[11px] tabular-nums">
        <span className={hasAdditions ? "text-mock-success" : "text-mock-fg-xmuted"}>
          +{entry.add}
        </span>
        <span className={hasRemovals ? "text-mock-danger" : "text-mock-fg-xmuted"}>
          -{entry.remove}
        </span>
      </span>
      {entry.kind === "file" ? (
        <ChangeStatusBox status={entry.status} />
      ) : (
        <span className="size-[15px] shrink-0" />
      )}
    </div>
  );
}

export function ExplorerChangesTree({ selectedFile }: { selectedFile?: string }) {
  return (
    <div className="min-h-0 flex-1 overflow-hidden">
      {CHANGES_TREE.map((entry) => (
        <ChangesTreeRow
          key={`${entry.depth}:${entry.name}`}
          entry={entry}
          selected={entry.kind === "file" && entry.name === selectedFile}
        />
      ))}
    </div>
  );
}

export function ChangesBranchRow() {
  return (
    <div
      className="flex shrink-0 items-center gap-[6px] border-b border-mock-border px-[14px] text-[12px] text-mock-fg-muted"
      style={SUBHEADER_STYLE}
    >
      main
      <ChevronDown size={12} />
    </div>
  );
}

export function ChangesScopeRow() {
  return (
    <div className="flex h-[36px] shrink-0 items-center border-b border-mock-border px-[14px]">
      <span className="flex items-center gap-[5px] text-[12px] text-mock-fg-muted">
        Uncommitted
        <ChevronDown size={12} />
      </span>
      <span className="ml-[9px] flex items-center gap-[5px] text-[11.5px] tabular-nums">
        <span className="text-mock-success">+1.9k</span>
        <span className="text-mock-danger">-684</span>
      </span>
      <span className="flex-1" />
      <span className="flex items-center gap-[12px] text-mock-fg-muted">
        <RefreshCw size={13} />
        <Ellipsis size={14} />
      </span>
    </div>
  );
}

export function ChangesCommitsRow() {
  return (
    <div className="flex h-[36px] shrink-0 items-center gap-[8px] border-t border-mock-border px-[10px] text-[12px] text-mock-fg">
      <ChevronRight size={13} className="text-mock-fg-muted" />
      Commits
    </div>
  );
}

/** The hunk shown when the first review file is expanded. */
export const PROVIDERS_HUNK: DiffRow[] = [
  { kind: "hunk", label: "@@ -75,7 +75,9 @@" },
  { kind: "line", n: "75", text: "" },
  {
    kind: "line",
    n: "76",
    text: "Pi RPC extension UI dialog requests (`select`, `input`, `editor`, `confirm`) are bridged",
  },
  { kind: "line", n: "77", text: "" },
  {
    kind: "line",
    n: "78",
    text: "OpenCode MCP injection is dynamic and session-scoped. Call OpenCode's `mcp.add` endpoint",
    mark: "remove",
  },
];

/** The hunk continues below the inline comment box. */
export const PROVIDERS_HUNK_TAIL: DiffRow[] = [
  {
    kind: "line",
    n: "78",
    text: "OpenCode 1 keeps MCP and process environment outside the session boundary. Paseo shares",
    mark: "add",
  },
  { kind: "line", n: "79", text: "", mark: "add" },
  {
    kind: "line",
    n: "80",
    text: "An agent with custom environment variables or user-configured MCP servers gets a server",
    mark: "add",
  },
  { kind: "line", n: "81", text: "" },
  {
    kind: "line",
    n: "82",
    text: "OpenCode owns user message IDs. Do not pass Paseo-generated IDs to OpenCode prompt APIs",
  },
  { kind: "line", n: "83", text: "" },
];

// --- content ----------------------------------------------------------------

export const UNCOMMITTED_ROWS: DiffRow[] = [
  { kind: "file", name: "alert.tsx", add: "12", remove: "18" },
  { kind: "line", n: "49", text: "  <div" },
  { kind: "line", n: "50", text: '    data-slot="alert-description"' },
  { kind: "line", n: "51", text: "    className={cn(" },
  {
    kind: "line",
    n: "52",
    text: '      "col-start-2 grid justify-items-start gap-1 text-sm tex',
  },
  { kind: "line", n: "59", text: "      className", mark: "remove" },
  { kind: "line", n: "53", text: "      className,", mark: "add" },
  { kind: "line", n: "54", text: "    )}" },
  { kind: "line", n: "55", text: "    {...props}" },
  { kind: "line", n: "56", text: "  />" },
  { kind: "line", n: "63", text: "  )", mark: "remove" },
  { kind: "line", n: "57", text: "  );", mark: "add" },
  { kind: "line", n: "58", text: "}" },
  { kind: "line", n: "59", text: "" },
  {
    kind: "line",
    n: "66",
    text: "export { Alert, AlertTitle, AlertDescription }",
    mark: "remove",
  },
  { kind: "line", n: "60", text: "export { Alert, AlertTitle, AlertDescription };", mark: "add" },
  { kind: "scrollbar" },
  { kind: "file", name: "badge.tsx", add: "11", remove: "13" },
  { kind: "file", name: "button.tsx", add: "12", remove: "14" },
  { kind: "file", name: "card.tsx", add: "13", remove: "30" },
  { kind: "hunk", label: "@@ -1,6 +1,6 @@" },
  { kind: "line", n: "1", text: 'import * as React from "react"', mark: "remove" },
  { kind: "line", n: "1", text: 'import * as React from "react";', mark: "add" },
  { kind: "line", n: "2", text: "" },
  { kind: "line", n: "3", text: 'import { cn } from "@/lib/utils"', mark: "remove" },
  { kind: "line", n: "3", text: 'import { cn } from "../../lib/utils.js";', mark: "add" },
  { kind: "line", n: "4", text: "" },
  {
    kind: "line",
    n: "5",
    text: 'function Card({ className, ...props }: React.ComponentProps<"di',
  },
  { kind: "line", n: "6", text: "  return (" },
  { kind: "hunk", label: "@@ -8,11 +8,11 @@" },
  { kind: "line", n: "8", text: '    data-slot="card"' },
  { kind: "line", n: "9", text: "    className={cn(" },
  {
    kind: "line",
    n: "10",
    text: '      "flex flex-col gap-6 rounded-xl border bg-card py-6 tex',
  },
  { kind: "line", n: "11", text: "      className", mark: "remove" },
  { kind: "line", n: "11", text: "      className,", mark: "add" },
  { kind: "line", n: "12", text: "    )}" },
  { kind: "line", n: "13", text: "    {...props}" },
  { kind: "line", n: "14", text: "  />" },
  { kind: "line", n: "15", text: "  )", mark: "remove" },
  { kind: "line", n: "15", text: "  );", mark: "add" },
  { kind: "line", n: "16", text: "}" },
  { kind: "line", n: "17", text: "" },
];

/** Same change set, room to breathe — used by the wide review pane. */
export const REVIEW_ROWS: DiffRow[] = [
  { kind: "hunk", label: "@@ -1,6 +1,6 @@" },
  { kind: "line", n: "1", text: 'import * as React from "react"', mark: "remove" },
  { kind: "line", n: "1", text: 'import * as React from "react";', mark: "add" },
  { kind: "line", n: "2", text: "" },
  { kind: "line", n: "3", text: 'import { cn } from "@/lib/utils"', mark: "remove" },
  { kind: "line", n: "3", text: 'import { cn } from "../../lib/utils.js";', mark: "add" },
  { kind: "line", n: "4", text: "" },
  {
    kind: "line",
    n: "5",
    text: 'function Card({ className, ...props }: React.ComponentProps<"div">) {',
  },
  { kind: "line", n: "6", text: "  return (" },
  { kind: "line", n: "7", text: "    <div" },
  { kind: "hunk", label: "@@ -8,15 +8,15 @@ function Card({ className, ...props })" },
  { kind: "line", n: "8", text: '      data-slot="card"' },
  { kind: "line", n: "9", text: "      className={cn(" },
  {
    kind: "line",
    n: "10",
    text: '        "flex flex-col gap-6 rounded-xl border bg-card py-6 text-card-foreground",',
  },
  { kind: "line", n: "11", text: "        className", mark: "remove" },
  { kind: "line", n: "11", text: "        className,", mark: "add" },
  { kind: "line", n: "12", text: "      )}" },
  { kind: "line", n: "13", text: "      {...props}" },
  { kind: "line", n: "14", text: "    />" },
  { kind: "line", n: "15", text: "  )", mark: "remove" },
  { kind: "line", n: "15", text: "  );", mark: "add" },
  { kind: "line", n: "16", text: "}" },
  { kind: "line", n: "17", text: "" },
  { kind: "hunk", label: "@@ -21,9 +21,9 @@ function CardHeader({ className, ...props })" },
  { kind: "line", n: "21", text: "function CardHeader({ className, ...props }) {" },
  { kind: "line", n: "22", text: "  return (" },
  { kind: "line", n: "23", text: "    <div" },
  { kind: "line", n: "24", text: '      data-slot="card-header"' },
  {
    kind: "line",
    n: "25",
    text: '      className={cn("grid auto-rows-min items-start", className)}',
    mark: "remove",
  },
  {
    kind: "line",
    n: "25",
    text: '      className={cn("grid auto-rows-min items-start gap-1.5", className)}',
    mark: "add",
  },
  { kind: "line", n: "26", text: "      {...props}" },
  { kind: "line", n: "27", text: "    />" },
  { kind: "line", n: "28", text: "  );" },
  { kind: "line", n: "29", text: "}" },
  { kind: "line", n: "30", text: "" },
  { kind: "hunk", label: "@@ -36,12 +36,12 @@ function CardTitle({ className, ...props })" },
  { kind: "line", n: "36", text: "function CardTitle({ className, ...props }) {" },
  { kind: "line", n: "37", text: "  return (" },
  { kind: "line", n: "38", text: "    <div" },
  { kind: "line", n: "39", text: '      data-slot="card-title"' },
  {
    kind: "line",
    n: "40",
    text: '      className={cn("leading-none", className)}',
    mark: "remove",
  },
  {
    kind: "line",
    n: "40",
    text: '      className={cn("leading-none font-semibold", className)}',
    mark: "add",
  },
  { kind: "line", n: "41", text: "      {...props}" },
  { kind: "line", n: "42", text: "    />" },
  { kind: "line", n: "43", text: "  )", mark: "remove" },
  { kind: "line", n: "43", text: "  );", mark: "add" },
  { kind: "line", n: "44", text: "}" },
  { kind: "line", n: "45", text: "" },
  {
    kind: "line",
    n: "46",
    text: "export { Card, CardHeader, CardTitle, CardContent }",
    mark: "remove",
  },
  {
    kind: "line",
    n: "46",
    text: "export { Card, CardHeader, CardTitle, CardContent };",
    mark: "add",
  },
];

export const REVIEW_FILES: {
  name: string;
  path: string;
  add: string;
  remove: string;
  active?: boolean;
}[] = [
  { name: "alert.tsx", path: "components/ui", add: "12", remove: "18" },
  { name: "badge.tsx", path: "components/ui", add: "11", remove: "13" },
  { name: "button.tsx", path: "components/ui", add: "12", remove: "14" },
  { name: "card.tsx", path: "components/ui", add: "13", remove: "30", active: true },
  { name: "sidebar.tsx", path: "components/ui", add: "48", remove: "9" },
  { name: "utils.ts", path: "lib", add: "3", remove: "1" },
];
