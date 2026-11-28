import type { RemoteHostId } from "./hosts";

/**
 * A collapsed tool call as the app's timeline shows it. Built-in tools carry a
 * fixed label; Paseo MCP tools name their action, such as "Create agent".
 */
export type ToolCall =
  | { kind: "read" | "write" | "shell"; detail: string }
  | { kind: "paseo"; label: string; detail?: string; host?: RemoteHostId };

/**
 * One step of a scripted scene. Beats play in order, each after the one before it ends.
 *
 * - `wait`: nothing happens.
 * - `click`: the pointer glides to a named target and clicks it.
 * - `type`: the user types into the composer.
 * - `user`: the typed message is sent and joins the transcript.
 * - `agent`: the agent's text streams into the transcript.
 * - `tools`: the agent's tool calls land one at a time.
 * - `turnEnd`: the turn finishes. With `worked`, its footer joins the transcript.
 * - `mark`: a named moment the rest of the window reacts to, such as a panel opening.
 */
export type Beat<Mark extends string = string, Target extends string = string> =
  | { kind: "wait"; ms: number }
  | { kind: "click"; target: Target }
  | { kind: "type"; text: string }
  | { kind: "user"; text: string }
  | { kind: "agent"; text: string }
  | { kind: "tools"; calls: ToolCall[] }
  | { kind: "turnEnd"; worked?: string }
  | { kind: "mark"; name: Mark; ms: number };

type TranscriptBeat =
  | Extract<Beat, { kind: "user" | "agent" | "tools" }>
  | { kind: "turnEnd"; worked: string };

/** A beat that leaves something in the transcript, with the span of time it plays over. */
export interface TranscriptEntry {
  id: string;
  start: number;
  end: number;
  beat: TranscriptBeat;
}

/** One click of the pointer: it glides to its target, presses the button, and lets go. */
export interface PointerClick {
  /**
   * How visible the pointer is for this click, from 0 to 1. It fades in on its way, and fades out
   * when the user types. A click right after another one takes the same pointer over, with no fade.
   */
  opacity(ms: number): number;
  /** How far the pointer has come on its way to the target, from 0 to 1. */
  approach(ms: number): number;
  /** Whether the pointer's button is down on the target. */
  pressed(ms: number): boolean;
  /** Whether the click has happened: the button went down and came back up. */
  done(ms: number): boolean;
}

/** The click target every scripted chat has. Clicking it puts the caret in the composer. */
export const COMPOSER = "composer";

/** What a chat pane reads from a script: the composer and the transcript at a point in time. */
export interface SceneScript {
  /** The length of the whole script. At this time the scene shows its finished state. */
  duration: number;
  entries: TranscriptEntry[];
  /** What the user is typing: the text so far, until it is sent. */
  draft(ms: number): string;
  /** Whether a turn is running: from the user's message until the turn ends. */
  busy(ms: number): boolean;
  /** How many transcript entries have started. */
  entered(ms: number): number;
  /** How much of an agent entry's text has streamed in. */
  streamed(entry: TranscriptEntry, ms: number): string;
  /** How many of a tools entry's calls have landed. */
  landed(entry: TranscriptEntry, ms: number): number;
  /** The script's click on a target. */
  click(target: string): PointerClick;
}

export interface Script<Mark extends string, Target extends string> extends SceneScript {
  click(target: Target): PointerClick;
  /** Whether a mark has started. */
  reached(mark: Mark, ms: number): boolean;
  /** How far through a mark the scene is, from 0 to 1. */
  progress(mark: Mark, ms: number): number;
}

// A demo types and streams faster than a person or a model does, and still reads as both.
const TYPING_MS_PER_CHARACTER = 14;
const SHORTEST_TYPING_MS = 700;
const PAUSE_BEFORE_SEND_MS = 320;
const SEND_MS = 420;
const STREAM_MS_PER_CHARACTER = 8;
const TOOL_CALL_MS = 320;
const TURN_END_MS = 420;
const POINTER_APPROACH_MS = 900;
const POINTER_PRESS_MS = 240;
const POINTER_FADE_MS = 150;

function typingMs(text: string): number {
  return Math.max(SHORTEST_TYPING_MS, text.length * TYPING_MS_PER_CHARACTER);
}

function beatMs(beat: Beat): number {
  switch (beat.kind) {
    case "wait":
    case "mark":
      return beat.ms;
    case "click":
      return POINTER_APPROACH_MS + POINTER_PRESS_MS;
    case "type":
      return typingMs(beat.text) + PAUSE_BEFORE_SEND_MS;
    case "user":
      return SEND_MS;
    case "agent":
      return beat.text.length * STREAM_MS_PER_CHARACTER;
    case "tools":
      return beat.calls.length * TOOL_CALL_MS;
    case "turnEnd":
      return TURN_END_MS;
  }
}

function isTranscriptBeat(beat: Beat): beat is TranscriptBeat {
  if (beat.kind === "turnEnd") return beat.worked !== undefined;
  return beat.kind === "user" || beat.kind === "agent" || beat.kind === "tools";
}

function fraction(start: number, end: number, ms: number): number {
  if (ms <= start) return 0;
  if (ms >= end) return 1;
  return (ms - start) / (end - start);
}

// A hand speeds a mouse up and slows it down again.
function easeInOut(linear: number): number {
  return linear < 0.5 ? 2 * linear * linear : 1 - (-2 * linear + 2) ** 2 / 2;
}

function hundredths(value: number): number {
  return Math.round(value * 100) / 100;
}

/** How a click's pointer comes and goes. */
interface PointerPresence {
  /** When the pointer sets off. */
  start: number;
  /** Whether the pointer is already on screen, at the click before this one. */
  continues: boolean;
  /** When the pointer goes away, or `Infinity` when it stays to the end of the scene. */
  leaves: number;
  /** Whether the next click takes the pointer over. Otherwise typing fades it out. */
  handsOver: boolean;
}

function pointerClick({ start, continues, leaves, handsOver }: PointerPresence): PointerClick {
  const pressStart = start + POINTER_APPROACH_MS;
  const pressEnd = pressStart + POINTER_PRESS_MS;
  return {
    opacity(ms) {
      if (ms >= leaves) {
        return handsOver ? 0 : hundredths(1 - fraction(leaves, leaves + POINTER_FADE_MS, ms));
      }
      if (continues) return ms >= start ? 1 : 0;
      return hundredths(fraction(start, start + POINTER_FADE_MS, ms));
    },
    approach: (ms) => Math.round(easeInOut(fraction(start, pressStart, ms)) * 1000) / 1000,
    pressed: (ms) => ms >= pressStart && ms < pressEnd,
    done: (ms) => ms >= pressEnd,
  };
}

/** Lays beats end to end and answers what the scene shows at any time. */
export function script<Mark extends string, Target extends string>(
  beats: Beat<Mark, Target>[],
): Script<Mark, Target> {
  let clock = 0;
  const timed = beats.map((beat, index) => {
    const start = clock;
    clock += beatMs(beat);
    return { id: `${index}:${beat.kind}`, start, end: clock, beat };
  });
  const duration = clock;

  const entries: TranscriptEntry[] = [];
  const typing: { start: number; end: number; text: string }[] = [];
  const turns: { start: number; end: number }[] = [];
  const marks = new Map<Mark, { start: number; end: number }>();
  const clicks = new Map<string, PointerClick>();
  // A hand that types is off the mouse, and the pointer has one place at a time. So typing takes
  // the pointer off screen, and a click that follows a click takes the pointer over from it.
  let pointerOnScreen = false;
  timed.forEach(({ start, beat }, index) => {
    if (beat.kind === "type") pointerOnScreen = false;
    if (beat.kind !== "click") return;
    const next = timed
      .slice(index + 1)
      .find((later) => later.beat.kind === "type" || later.beat.kind === "click");
    clicks.set(
      beat.target,
      pointerClick({
        start,
        continues: pointerOnScreen,
        leaves: next ? next.start : Infinity,
        handsOver: next?.beat.kind === "click",
      }),
    );
    pointerOnScreen = true;
  });
  for (const { id, start, end, beat } of timed) {
    if (isTranscriptBeat(beat)) entries.push({ id, start, end, beat });
    if (beat.kind === "type") typing.push({ start, end, text: beat.text });
    if (beat.kind === "user") turns.push({ start, end: duration });
    if (beat.kind === "turnEnd") {
      const turn = turns.at(-1);
      if (turn) turn.end = start;
    }
    if (beat.kind === "mark") marks.set(beat.name, { start, end });
  }

  function span(mark: Mark) {
    const found = marks.get(mark);
    if (!found) throw new Error(`The script has no mark named ${mark}`);
    return found;
  }

  return {
    duration,
    entries,
    draft(ms) {
      const beat = typing.find(({ start, end }) => ms >= start && ms < end);
      if (!beat) return "";
      const typed = fraction(beat.start, beat.start + typingMs(beat.text), ms);
      return beat.text.slice(0, Math.ceil(typed * beat.text.length));
    },
    busy(ms) {
      return turns.some(({ start, end }) => ms >= start && ms < end);
    },
    entered(ms) {
      // The last entry enters at the end of a script that closes on it, so the end counts.
      return entries.filter(({ start }) => ms > start || ms >= duration).length;
    },
    streamed(entry, ms) {
      if (entry.beat.kind !== "agent") return "";
      const { text } = entry.beat;
      return text.slice(0, Math.ceil(fraction(entry.start, entry.end, ms) * text.length));
    },
    landed(entry, ms) {
      if (entry.beat.kind !== "tools") return 0;
      return Math.ceil(fraction(entry.start, entry.end, ms) * entry.beat.calls.length);
    },
    reached(mark, ms) {
      return ms > span(mark).start || ms >= duration;
    },
    progress(mark, ms) {
      const { start, end } = span(mark);
      return fraction(start, end, ms);
    },
    click(target) {
      const found = clicks.get(target);
      if (!found) throw new Error(`The script has no click on ${target}`);
      return found;
    },
  };
}
