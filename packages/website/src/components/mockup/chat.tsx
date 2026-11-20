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
import { motion } from "framer-motion";
import type * as React from "react";
import { useTranslation } from "react-i18next";
import { Caret, DiffStat } from "./atoms";
import { HostBadge } from "./hosts";
import { PaseoMark } from "./icons";
import { FADE_IN, FADE_OUT } from "./motion";
import { DELEGATED_TASKS, SUBAGENTS_CLICK, tasksDelegated } from "./orchestration";
import { useSceneClock } from "./player";
import { Pointer } from "./pointer";
import { PROVIDERS, type ProviderId } from "./providers";
import { COMPOSER, type SceneScript, type ToolCall, type TranscriptEntry } from "./script";
import type { MockupStateId } from "./states";

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

const BUILT_IN_LABELS = { read: "Read", write: "Write", shell: "Shell" } as const;

function toolCallLabel(call: ToolCall): string {
  return call.kind === "paseo" ? call.label : BUILT_IN_LABELS[call.kind];
}

function ToolCallIcon({ kind }: { kind: ToolCall["kind"] }) {
  if (kind === "read") return <Eye size={14} />;
  if (kind === "write") return <Pencil size={14} />;
  if (kind === "paseo") return <PaseoMark size={14} />;
  return <SquareTerminal size={14} />;
}

/**
 * One tool call row, drawn like the app's collapsed timeline item
 * (`packages/app/src/components/message.tsx`): icon, label, then the summary,
 * all muted and in the UI font. A Paseo call that targets another machine ends
 * with that host's badge, which the app's row does not draw.
 */
export function ToolCallRow({ call }: { call: ToolCall }) {
  return (
    <div className="flex items-center gap-[8px] py-[5px] text-[12.5px] leading-[18px] text-mock-fg-muted">
      <span className="shrink-0">
        <ToolCallIcon kind={call.kind} />
      </span>
      <span className="shrink-0">{toolCallLabel(call)}</span>
      {call.detail ? <span className="min-w-0 truncate">{call.detail}</span> : null}
      {call.kind === "paseo" && call.host ? <HostBadge host={call.host} glyph={13} /> : null}
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
      <TurnFooter duration="1m 18s" />
    </div>
  );
}

/** Something that fades in when the script reaches it. */
function Entering({ children }: { children: React.ReactNode }) {
  return (
    <motion.div initial={FADE_OUT} animate={FADE_IN}>
      {children}
    </motion.div>
  );
}

interface ScriptedProps {
  scene: MockupStateId;
  script: SceneScript;
}

function StreamedText({ scene, script, entry }: ScriptedProps & { entry: TranscriptEntry }) {
  const text = useSceneClock(scene, (ms) => script.streamed(entry, ms));
  return <Para>{text}</Para>;
}

function LandedTools({
  scene,
  script,
  entry,
  calls,
}: ScriptedProps & { entry: TranscriptEntry; calls: ToolCall[] }) {
  const landed = useSceneClock(scene, (ms) => script.landed(entry, ms));
  return (
    <div>
      {calls.slice(0, landed).map((call) => (
        <Entering key={`${call.kind}:${call.detail}`}>
          <ToolCallRow call={call} />
        </Entering>
      ))}
    </div>
  );
}

function TranscriptEntryView({ scene, script, entry }: ScriptedProps & { entry: TranscriptEntry }) {
  const { beat } = entry;
  if (beat.kind === "agent") return <StreamedText scene={scene} script={script} entry={entry} />;
  if (beat.kind === "tools") {
    return <LandedTools scene={scene} script={script} entry={entry} calls={beat.calls} />;
  }
  if (beat.kind === "user") {
    return (
      <Entering>
        <UserBubble>{beat.text}</UserBubble>
      </Entering>
    );
  }
  return (
    <Entering>
      <TurnFooter duration={beat.worked} />
    </Entering>
  );
}

/** The transcript of a scripted scene, as far as its script has played. */
export function ScriptedTranscript({ scene, script }: ScriptedProps) {
  const entered = useSceneClock(scene, script.entered);
  return (
    <div className="space-y-[13px] pt-[2px]">
      {script.entries.slice(0, entered).map((entry) => (
        <TranscriptEntryView key={entry.id} scene={scene} script={script} entry={entry} />
      ))}
    </div>
  );
}

// --- composer ---------------------------------------------------------------

/** One composer control: its icon as the child, then the current value. */
function ControlPill({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="flex items-center gap-[6px] whitespace-nowrap text-[12px] text-mock-fg-muted">
      {children}
      {label}
      <ChevronDown size={11} className="text-mock-fg-xmuted" />
    </span>
  );
}

/**
 * A rounded pill that floats above the composer — task tracker, subagents, diff. An open pill is
 * the one whose panel is showing.
 */
function ComposerPill({ children, open = false }: { children: React.ReactNode; open?: boolean }) {
  return (
    <span
      className={`flex items-center gap-[6px] rounded-full border border-mock-border-accent px-[11px] py-[4px] text-[11.5px] ${
        open ? "bg-mock-surface2 text-mock-fg" : "text-mock-fg-muted"
      }`}
    >
      {children}
    </span>
  );
}

function SubagentsPill({ count, open = false }: { count: number; open?: boolean }) {
  const { t } = useTranslation();
  return (
    <ComposerPill open={open}>
      <CircleDot size={12} className="text-mock-dot-running" />
      {t("landing.mockup.app.subagents", { count })}
    </ComposerPill>
  );
}

/** The row of pills above the composer input. */
function ComposerTrack({ children }: { children: React.ReactNode }) {
  return <div className="pb-[13px]">{children}</div>;
}

/** The trackers of a turn in progress: tasks, subagents, and the diff so far. */
export function ProgressTrack() {
  const { t } = useTranslation();
  return (
    <ComposerTrack>
      <div className="flex items-center gap-[8px]">
        <ComposerPill>
          {t("landing.mockup.app.tasksProgress", { completed: 6, total: 6 })}
        </ComposerPill>
        <SubagentsPill count={DELEGATED_TASKS.length} />
        <ComposerPill>
          <DiffStat add="1.9k" remove="684" />
        </ComposerPill>
      </div>
    </ComposerTrack>
  );
}

function SubagentRow({ task }: { task: (typeof DELEGATED_TASKS)[number] }) {
  const provider = PROVIDERS[task.provider];
  return (
    <div className="flex items-start gap-[9px] px-[12px] py-[6px]">
      <span className="relative mt-[2px] block size-[14px] shrink-0 text-mock-fg-muted">
        <provider.Icon size={14} />
        <span className="absolute -right-[2px] -bottom-[2px] size-[6px] rounded-full bg-mock-dot-running ring-[1.5px] ring-mock-surface1" />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[13px] leading-[18px] text-mock-fg">{task.title}</span>
        <span className="flex items-center gap-[6px] text-[11.5px] leading-[16px] text-mock-fg-muted">
          <span>
            {provider.name} · {provider.model}
          </span>
          {task.host ? (
            <>
              <span className="text-mock-fg-xmuted">·</span>
              <HostBadge host={task.host} />
            </>
          ) : null}
        </span>
      </span>
    </div>
  );
}

// Where the pointer sets off from, in design pixels from the spot it clicks.
const POINTER_TO_PILL = { x: 236, y: -128 };
const POINTER_TO_COMPOSER = { x: 230, y: -140 };

const ROSTER_CLOSED = { opacity: 0, scale: 0.97, y: 6 };
const ROSTER_OPEN = { opacity: 1, scale: 1, y: 0 };

/**
 * The Subagents track of the orchestration scene. Its pill appears with the first subagent and
 * counts each one the orchestrator launches. When the pointer clicks the pill, the roster opens:
 * one row per agent, drawn like the app's track rows (`packages/app/src/subagents/track.tsx`).
 * The title is the task and the line under it names the provider and model. An agent on another
 * machine ends that line with the host's badge, where the app writes the host's name in plain text.
 */
export function SubagentsTrack() {
  const launched = useSceneClock("orchestrate", tasksDelegated);
  const pressed = useSceneClock("orchestrate", SUBAGENTS_CLICK.pressed);
  const open = useSceneClock("orchestrate", SUBAGENTS_CLICK.done);
  if (launched === 0) return null;
  return (
    <ComposerTrack>
      {open ? (
        <motion.div
          initial={ROSTER_CLOSED}
          animate={ROSTER_OPEN}
          className="mb-[6px] w-fit min-w-[280px] origin-bottom-left rounded-[11px] border border-mock-border-accent bg-mock-surface1 py-[4px] shadow-[0_8px_24px_rgba(0,0,0,0.4)]"
        >
          {DELEGATED_TASKS.map((task) => (
            <SubagentRow key={task.id} task={task} />
          ))}
        </motion.div>
      ) : null}
      <Entering>
        <span className="relative flex w-fit">
          <SubagentsPill count={launched} open={pressed || open} />
          <Pointer
            scene="orchestrate"
            click={SUBAGENTS_CLICK}
            from={POINTER_TO_PILL}
            className="top-[58%] left-[91%]"
          />
        </span>
      </Entering>
    </ComposerTrack>
  );
}

/** The amber ring the app shows while a turn is streaming. */
function BusyRing() {
  return <LoaderCircle size={14} className="text-mock-warning" strokeWidth={2.4} />;
}

export function Composer({
  track,
  agent = "codex",
  busy = false,
  draft = "",
  focused = false,
  children,
}: {
  /** The composer track shown above the input, such as `ProgressTrack`. It brings its own spacing. */
  track?: React.ReactNode;
  /** Which provider's agent this composer talks to. */
  agent?: ProviderId;
  busy?: boolean;
  /** What the user has typed and not yet sent. Empty shows the placeholder. */
  draft?: string;
  /** Whether the caret is in the input. */
  focused?: boolean;
  /** Something drawn over the input box, such as the pointer that clicks it. */
  children?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const provider = PROVIDERS[agent];
  return (
    <div className="shrink-0 px-[27px] pt-[16px] pb-[17px]">
      {track}
      <div className="relative rounded-[11px] border border-mock-border-accent bg-mock-surface1">
        {children}
        <div className="px-[14px] pt-[13px] pb-[12px]">
          <div className="flex items-start gap-[10px]">
            {draft ? (
              <span className="min-w-0 flex-1 text-[13px] text-mock-fg">
                {draft}
                <Caret className="ml-px" />
              </span>
            ) : (
              <span className="min-w-0 flex-1 text-[13px] text-mock-surface4">
                {/* The caret takes no room, so the placeholder does not move when it appears. */}
                {focused ? <Caret className="-mr-px" /> : null}
                {t("landing.mockup.app.composerPlaceholder")}
              </span>
            )}
          </div>
          <div className="flex items-center gap-[17px] pt-[26px]">
            <Plus size={15} className="text-mock-fg-muted" />
            <ControlPill label={provider.model}>
              <provider.Icon size={13} />
            </ControlPill>
            <ControlPill label="Medium">
              <Brain size={13} />
            </ControlPill>
            <ControlPill label="Full access">
              <ShieldOff size={13} />
            </ControlPill>
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

/**
 * The composer of a scripted scene. The pointer clicks it, which puts the caret in it. Then the
 * script types into it and says when a turn is running.
 */
export function ScriptedComposer({
  scene,
  script,
  agent,
  track,
}: ScriptedProps & { agent: ProviderId; track?: React.ReactNode }) {
  const click = script.click(COMPOSER);
  const draft = useSceneClock(scene, script.draft);
  const busy = useSceneClock(scene, script.busy);
  const focused = useSceneClock(scene, (ms) => click.pressed(ms) || click.done(ms));
  return (
    <Composer agent={agent} track={track} busy={busy} draft={draft} focused={focused}>
      <Pointer
        scene={scene}
        click={click}
        from={POINTER_TO_COMPOSER}
        className="top-[22px] left-[168px]"
      />
    </Composer>
  );
}
