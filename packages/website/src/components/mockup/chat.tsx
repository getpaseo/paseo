import {
  AudioLines,
  Brain,
  ChevronDown,
  CircleDot,
  Copy,
  Eye,
  LoaderCircle,
  ListTodo,
  Mic,
  Pencil,
  Plus,
  ShieldOff,
  Split,
  SquareTerminal,
  Zap,
} from "lucide-react";
import type * as React from "react";
import { useTranslation } from "react-i18next";
import { DiffStat } from "./atoms";
import { CodexIcon, PaseoMark } from "./icons";

// Icons passed as props are hoisted so they are not rebuilt on every render.
const MODEL_ICON = <CodexIcon size={13} />;
const EFFORT_ICON = <Brain size={13} />;
const ACCESS_ICON = <ShieldOff size={13} />;

// --- transcript -------------------------------------------------------------

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex gap-[10px] text-[13.5px] leading-[22px] text-mock-fg">
      <span className="text-mock-fg-muted">·</span>
      <span>{children}</span>
    </div>
  );
}

function Para({ children }: { children: React.ReactNode }) {
  return <p className="text-[13.5px] leading-[20px] text-mock-fg">{children}</p>;
}

/** The user's message — a right-aligned bubble that opens the turn. */
function UserBubble({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex justify-end pb-[12px]">
      <span className="max-w-[80%] rounded-[11px] bg-mock-surface2 px-[13px] py-[8px] text-[13px] leading-[19px] text-mock-fg">
        {children}
      </span>
    </div>
  );
}

/** The message footer — copy, branch off, and how long the turn took. */
function TurnFooter({ duration }: { duration: string }) {
  return (
    <div className="flex items-center gap-[16px] pt-[14px] text-mock-fg-muted">
      <Copy size={14} />
      <Split size={14} />
      <span className="text-[12.5px]">Worked for {duration}</span>
    </div>
  );
}

export function AgentTranscript() {
  return (
    <div className="space-y-[13px] pt-[2px]">
      <Para>
        The homepage is built. It leads with Paseo&rsquo;s actual value, then uses the product
        itself to prove the story instead of falling back to generic dashboard art.
      </Para>
      <div>
        <Bullet>Reworked the hero around &ldquo;The control plane for coding agents.&rdquo;</Bullet>
        <Bullet>Built desktop and mobile scenes from real Paseo workflows and assets.</Bullet>
        <Bullet>Added believable agent, review, plugin, shipping, and host states.</Bullet>
        <Bullet>
          Matched the app&rsquo;s tabs, explorer, diff tree, controls, and layout rails.
        </Bullet>
      </div>
      <TurnFooter duration="31m 46s" />
      <UserBubble>Create a PR</UserBubble>
      <Para>PR opened: Rebuild the homepage around live Paseo workflows.</Para>
      <span className="block text-[13.5px] text-mock-accent-bright">
        https://github.com/getpaseo/paseo/pull/3981
      </span>
      <div>
        <Bullet>Ships the new product-led hero and interactive desktop mockup.</Bullet>
        <Bullet>Includes responsive mobile proof and the supporting homepage story.</Bullet>
        <Bullet>Formatting, typecheck, and lint are clean.</Bullet>
      </div>
      <Para>Ready for review.</Para>
      <TurnFooter duration="1m 18s" />
    </div>
  );
}

/**
 * A collapsed tool call as the app's timeline shows it. Built-in tools carry a
 * fixed label; Paseo MCP tools name their action, such as "Create agent".
 */
export type ToolCall =
  | { kind: "read" | "write" | "shell"; detail: string }
  | { kind: "paseo"; label: string; detail: string };

const BUILT_IN_LABELS = { read: "Read", write: "Write", shell: "Shell" } as const;

function toolCallLabel(call: ToolCall): string {
  return call.kind === "paseo" ? call.label : BUILT_IN_LABELS[call.kind];
}

const PLUGIN_TOOL_CALLS: ToolCall[] = [
  { kind: "read", detail: "paseo-plugin/SKILL.md" },
  { kind: "shell", detail: "paseo plugin init ~/dev/release-radar" },
  { kind: "write", detail: "~/dev/release-radar/index.ts" },
  { kind: "write", detail: "~/dev/release-radar/release-radar.client.tsx" },
  { kind: "shell", detail: "npm install && npm run typecheck" },
  { kind: "shell", detail: "paseo plugin install ~/dev/release-radar" },
];

const PLUGIN_DISCOVERY_CALLS = PLUGIN_TOOL_CALLS.slice(0, 1);
const PLUGIN_BUILD_CALLS = PLUGIN_TOOL_CALLS.slice(1, 4);
const PLUGIN_INSTALL_CALLS = PLUGIN_TOOL_CALLS.slice(4);

function ToolCallIcon({ kind }: { kind: ToolCall["kind"] }) {
  if (kind === "read") return <Eye size={14} />;
  if (kind === "write") return <Pencil size={14} />;
  if (kind === "paseo") return <PaseoMark size={14} />;
  return <SquareTerminal size={14} />;
}

/**
 * One tool call row, drawn like the app's collapsed timeline item
 * (`packages/app/src/components/message.tsx`): icon, label, then the summary,
 * all muted and in the UI font.
 */
export function ToolCallRow({ call }: { call: ToolCall }) {
  return (
    <div className="flex items-center gap-[8px] py-[5px] text-[12.5px] leading-[18px] text-mock-fg-muted">
      <span className="shrink-0">
        <ToolCallIcon kind={call.kind} />
      </span>
      <span className="shrink-0">{toolCallLabel(call)}</span>
      <span className="min-w-0 truncate">{call.detail}</span>
    </div>
  );
}

function PluginToolGroup({ calls }: { calls: ToolCall[] }) {
  return (
    <div>
      {calls.map((call) => (
        <ToolCallRow key={`${call.kind}:${call.detail}`} call={call} />
      ))}
    </div>
  );
}

export function PluginBuildTranscript() {
  return (
    <div className="space-y-[13px] pt-[2px]">
      <UserBubble>
        Build me a release radar for Paseo. I want an explorer panel showing merged PRs, changes in
        review, failing checks, and seven-day activity, accessible from the sidebar.
      </UserBubble>
      <Para>
        I&rsquo;ll scaffold a local plugin, add the explorer surface, and wire it into the sidebar.
      </Para>
      <PluginToolGroup calls={PLUGIN_DISCOVERY_CALLS} />
      <Para>
        The plugin API exposes Paseo&rsquo;s live project and workspace state, so the radar
        doesn&rsquo;t need a separate service.
      </Para>
      <PluginToolGroup calls={PLUGIN_BUILD_CALLS} />
      <Para>The surface is wired. I&rsquo;m checking the project and installing it now.</Para>
      <PluginToolGroup calls={PLUGIN_INSTALL_CALLS} />
      <Para>Release Radar is live. It should now be visible in the right sidebar.</Para>
      <TurnFooter duration="2m 14s" />
    </div>
  );
}

// --- composer ---------------------------------------------------------------

function ControlPill({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <span className="flex items-center gap-[6px] text-[12px] text-mock-fg-muted">
      {icon}
      {label}
      <ChevronDown size={11} className="text-mock-fg-xmuted" />
    </span>
  );
}

/** A rounded pill that floats above the composer — task tracker, subagents, diff. */
function ComposerPill({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-[6px] rounded-full border border-mock-border-accent px-[11px] py-[4px] text-[11.5px] text-mock-fg-muted">
      {children}
    </span>
  );
}

/** The amber ring the app shows while a turn is streaming. */
function BusyRing() {
  return <LoaderCircle size={14} className="text-mock-warning" strokeWidth={2.4} />;
}

export function Composer({
  showProgress = true,
  busy = true,
}: {
  showProgress?: boolean;
  busy?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <div className="shrink-0 px-[27px] pt-[16px] pb-[17px]">
      <div className={showProgress ? "pb-[13px]" : ""}>
        {showProgress ? (
          <div className="flex items-center gap-[8px]">
            <ComposerPill>
              {t("landing.mockup.app.tasksProgress", { completed: 6, total: 6 })}
            </ComposerPill>
            <ComposerPill>
              <CircleDot size={12} className="text-mock-dot-running" />
              {t("landing.mockup.app.subagents", { count: 3 })}
            </ComposerPill>
            <ComposerPill>
              <DiffStat add="1.9k" remove="684" />
            </ComposerPill>
          </div>
        ) : null}
      </div>
      <div className="rounded-[11px] border border-mock-border-accent bg-mock-surface1">
        <div className="px-[14px] pt-[13px] pb-[12px]">
          <div className="flex items-start gap-[10px]">
            <span className="min-w-0 flex-1 text-[13px] text-mock-surface4">
              {t("landing.mockup.app.composerPlaceholder")}
            </span>
          </div>
          <div className="flex items-center gap-[17px] pt-[26px]">
            <Plus size={15} className="text-mock-fg-muted" />
            <ControlPill icon={MODEL_ICON} label="GPT-5.6-Sol" />
            <ControlPill icon={EFFORT_ICON} label="Medium" />
            <ControlPill icon={ACCESS_ICON} label="Full access" />
            <Zap size={14} className="text-mock-fg-muted" />
            <ListTodo size={14} className="text-mock-fg-muted" />
            <span className="flex-1" />
            {busy ? <BusyRing /> : null}
            <Mic size={14} className="text-mock-fg-muted" />
            <AudioLines size={14} className="text-mock-fg-muted" />
          </div>
        </div>
      </div>
    </div>
  );
}
