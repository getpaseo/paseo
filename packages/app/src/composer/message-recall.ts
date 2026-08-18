import type { StreamItem } from "@/types/stream";

/**
 * Shell-style recall of previously sent messages.
 *
 * Recall reads two sources, both without asking the daemon: the prompts this client sent while
 * the app has been open, and the user messages in the timeline the client has already loaded.
 * Nothing is persisted and nothing is mirrored into component state, so there is no second copy
 * of the conversation to keep in sync across rewind, reload, and agent switching.
 */

/** Nobody walks past this, and the cap keeps the scan bounded on long timelines. */
const MAX_RECALL_ENTRIES = 100;

export type RecallDirection = "older" | "newer";

export interface RecallKeyEvent {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}

export interface RecallSelection {
  start: number;
  end: number;
}

export interface RecallSnapshot {
  text: string;
  selection: RecallSelection;
}

/** A walk in progress. Absent while the user is writing their own text. */
export interface RecallSession {
  /** 0 is the most recent sent message. */
  index: number;
  /** What recall put in the composer, so an edit to it is recognisable. */
  recalled: string;
  /** What the user was holding when the walk started, returned to by walking forward. */
  stash: RecallSnapshot;
}

export interface RecallOutcome {
  /** The walk to remember, or null once the composer is back on the user's own text. */
  session: RecallSession | null;
  text: string;
  selection: RecallSelection;
}

/**
 * Prompts this client sent, newest first, per agent.
 *
 * The loaded timeline only reaches back one page (TIMELINE_FETCH_PAGE_SIZE), and a turn with
 * tool calls fills that page on its own, so deriving recall from it alone reaches barely one
 * prompt. What this session sent is known without asking the daemon, so it is kept here — in
 * memory, for as long as the app is open, and never persisted.
 */
const sentPromptsByAgent = new Map<string, string[]>();

function recallKey(input: { serverId: string; agentId: string }): string {
  return `${input.serverId}:${input.agentId}`;
}

export function rememberSentPrompt(input: {
  serverId: string;
  agentId: string;
  text: string;
}): void {
  const text = input.text.trim();
  if (!text) return;
  const key = recallKey(input);
  const remembered = sentPromptsByAgent.get(key) ?? [];
  if (remembered[0] === text) return;
  sentPromptsByAgent.set(key, [text, ...remembered].slice(0, MAX_RECALL_ENTRIES));
}

/**
 * Newest first: what this client sent, then whatever else the loaded timeline still holds.
 *
 * Its own sends come first because that is what the user is reaching back for. The two only
 * disagree when another device sent something in between, and then recall is still complete,
 * just ordered by who sent it rather than when.
 */
export function readRecallHistory(input: {
  serverId: string;
  agentId: string;
  timeline: readonly StreamItem[] | undefined;
}): string[] {
  const remembered = sentPromptsByAgent.get(recallKey(input)) ?? [];
  const history = [...remembered];
  const seen = new Set(history);
  for (const text of collectSentMessages(input.timeline)) {
    if (history.length >= MAX_RECALL_ENTRIES) break;
    if (seen.has(text)) continue;
    seen.add(text);
    history.push(text);
  }
  return history;
}

/** Tests only — the remembered prompts outlive any one component. */
export function forgetSentPrompts(): void {
  sentPromptsByAgent.clear();
}

/** Newest first, blank messages and adjacent repeats dropped. */
export function collectSentMessages(items: readonly StreamItem[] | undefined): string[] {
  if (!items) return [];
  const history: string[] = [];
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (history.length >= MAX_RECALL_ENTRIES) break;
    const item = items[index];
    if (item?.kind !== "user_message") continue;
    const text = item.text.trim();
    if (!text) continue;
    if (history[history.length - 1] === text) continue;
    history.push(text);
  }
  return history;
}

/**
 * Modified arrows belong to the platform and to Paseo's own shortcuts (Cmd+Shift+Arrow moves
 * between splits), so recall only claims a bare Up or Down.
 */
export function resolveRecallDirection(event: RecallKeyEvent): RecallDirection | null {
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null;
  if (event.key === "ArrowUp") return "older";
  if (event.key === "ArrowDown") return "newer";
  return null;
}

function caretAtEnd(text: string): RecallSelection {
  return { start: text.length, end: text.length };
}

function isWalking(
  session: RecallSession | null,
  history: readonly string[],
  text: string,
): session is RecallSession {
  if (!session) return false;
  // An edit to the recalled text ends the walk, and so does history moving underneath it.
  return session.recalled === text && history[session.index] === session.recalled;
}

/**
 * Resolve one Up or Down press.
 *
 * Up walks back through sent messages and stashes whatever was in the composer, so a half
 * written prompt comes back on the way forward. Recall only claims the key when the caret has
 * nowhere left to go in that direction — Up on the first line, Down on the last — which leaves
 * multi-line editing alone and keeps the two behaviours in one muscle memory.
 *
 * Returns `null` when there is no step to take, leaving the key to its default handling.
 */
export function resolveRecall(input: {
  history: readonly string[];
  session: RecallSession | null;
  snapshot: RecallSnapshot;
  direction: RecallDirection;
}): RecallOutcome | null {
  const { history, session, snapshot, direction } = input;
  const { text, selection } = snapshot;
  // A range selection is the platform's to collapse.
  if (selection.start !== selection.end) return null;
  const caret = selection.start;
  const walking = isWalking(session, history, text);

  if (direction === "older") {
    if (text.slice(0, caret).includes("\n")) return null;
    if (!walking) {
      const newest = history[0];
      if (newest === undefined) return null;
      return step({ index: 0, recalled: newest, stash: snapshot });
    }
    const older = history[session.index + 1];
    if (older === undefined) return null;
    return step({ index: session.index + 1, recalled: older, stash: session.stash });
  }

  if (!walking) return null;
  if (text.slice(caret).includes("\n")) return null;
  const newer = history[session.index - 1];
  if (newer !== undefined) {
    return step({ index: session.index - 1, recalled: newer, stash: session.stash });
  }
  // Past the newest message the walk is over, and the composer goes back to what it was holding.
  return { session: null, text: session.stash.text, selection: session.stash.selection };
}

function step(session: RecallSession): RecallOutcome {
  return { session, text: session.recalled, selection: caretAtEnd(session.recalled) };
}

/**
 * Whether leaving the composer mid-walk should put the stash back.
 *
 * Recall writes through the draft, so a walk that is abandoned by switching agents or closing
 * the tab would persist a recalled message over what the user was writing. Restoring is only
 * right while the recalled text is still standing — once the draft has moved on, by sending,
 * queueing, or dictating over it, the stash is stale and belongs nowhere.
 */
export function shouldRestoreStash(input: {
  session: RecallSession | null;
  draftText: string;
}): input is { session: RecallSession; draftText: string } {
  return input.session !== null && input.session.recalled === input.draftText;
}
