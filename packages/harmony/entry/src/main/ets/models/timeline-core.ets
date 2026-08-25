/**
 * Timeline core — ported from packages/app/src/timeline/session-stream-reducers.ts
 * and packages/app/src/types/stream.ts.
 *
 * Handles:
 * 1. Converting raw daemon timeline entries into StreamItem[] arrays
 * 2. Sequence-number-based deduplication and gap detection
 * 3. Merging incremental timeline pages (tail, before, after)
 */

import type {
  StreamItem,
  TimelineCursor,
  TimelineEvent,
  TimelineEventItem,
  UserMessageItem,
  AssistantMessageItem,
  ThoughtItem,
  ToolCallItem,
  ActivityLogItem,
  ActivityLogType,
  AgentToolCallStatus,
} from './stream-types';
import { generateStreamId } from './stream-types';

const MAX_HEAD_SIZE = 200;

interface HydratedEntry {
  event: TimelineEvent;
  timestamp: number;
  seq: number;
}

function appendStreamItem(items: StreamItem[], item: StreamItem): StreamItem[] {
  items.push(item);
  return items;
}

function buildUserMessage(item: TimelineEventItem, timestamp: number): UserMessageItem {
  const msg: UserMessageItem = {
    kind: 'user_message',
    id: generateStreamId('user'),
    text: item.text !== undefined ? item.text : '',
    timestamp: timestamp,
  };
  return msg;
}

function buildAssistantMessage(item: TimelineEventItem, timestamp: number): AssistantMessageItem {
  const msg: AssistantMessageItem = {
    kind: 'assistant_message',
    id: item.messageId !== undefined ? item.messageId : generateStreamId('assistant'),
    text: item.text !== undefined ? item.text : '',
    timestamp: timestamp,
  };
  return msg;
}

function buildThought(item: TimelineEventItem, timestamp: number): ThoughtItem {
  const thought: ThoughtItem = {
    kind: 'thought',
    id: generateStreamId('thought'),
    text: item.text !== undefined ? item.text : '',
    timestamp: timestamp,
    status: 'ready',
  };
  return thought;
}

function buildToolCall(item: TimelineEventItem, timestamp: number): ToolCallItem {
  const tc: ToolCallItem = {
    kind: 'tool_call',
    id: generateStreamId('tool'),
    timestamp: timestamp,
    callId: item.callId !== undefined ? item.callId : 'unknown',
    provider: '',
    name: item.name !== undefined ? item.name : 'unknown',
    status: (item.status !== undefined ? item.status : 'running') as AgentToolCallStatus,
    detail: item.detail !== undefined ? item.detail : {} as ESObject,
  };
  return tc;
}

function buildActivityLog(item: TimelineEventItem, timestamp: number): ActivityLogItem {
  const activityType: ActivityLogType = (item.status === 'failed' ? 'error' : 'info') as ActivityLogType;
  const log: ActivityLogItem = {
    kind: 'activity_log',
    id: generateStreamId('activity'),
    timestamp: timestamp,
    activityType: activityType,
    message: item.message !== undefined ? item.message : (item.text !== undefined ? item.text : ''),
  };
  return log;
}

function mergeAssistantText(existing: StreamItem[], text: string, timestamp: number): StreamItem[] {
  const last: StreamItem | undefined = existing.length > 0 ? existing[existing.length - 1] : undefined;
  if (last !== undefined && last.kind === 'assistant_message') {
    const updated: AssistantMessageItem = {
      kind: 'assistant_message',
      id: last.id,
      text: last.text + text,
      timestamp: timestamp,
    };
    const next: StreamItem[] = [];
    for (let i = 0; i < existing.length; i++) {
      next.push(existing[i]);
    }
    next[next.length - 1] = updated;
    return next;
  }
  return existing;
}

export function reduceStreamUpdate(
  state: StreamItem[],
  event: TimelineEvent,
  timestamp: number,
): StreamItem[] {
  const item: TimelineEventItem = event.item;

  switch (item.type) {
    case 'user_message': {
      const next: StreamItem[] = [];
      for (let i = 0; i < state.length; i++) {
        next.push(state[i]);
      }
      return appendStreamItem(next, buildUserMessage(item, timestamp));
    }

    case 'assistant_message': {
      const last: StreamItem | undefined = state.length > 0 ? state[state.length - 1] : undefined;
      if (last !== undefined && last.kind === 'assistant_message') {
        return mergeAssistantText(state, item.text !== undefined ? item.text : '', timestamp);
      }
      const next: StreamItem[] = [];
      for (let i = 0; i < state.length; i++) {
        next.push(state[i]);
      }
      return appendStreamItem(next, buildAssistantMessage(item, timestamp));
    }

    case 'reasoning': {
      const next: StreamItem[] = [];
      for (let i = 0; i < state.length; i++) {
        next.push(state[i]);
      }
      return appendStreamItem(next, buildThought(item, timestamp));
    }

    case 'tool_call': {
      if (item.callId !== undefined) {
        const callId: string = item.callId;
        let existingIdx = -1;
        for (let i = state.length - 1; i >= 0; i--) {
          const s: StreamItem = state[i];
          if (s.kind === 'tool_call' && (s as ToolCallItem).callId === callId) {
            existingIdx = i;
            break;
          }
        }
        if (existingIdx >= 0) {
          const next: StreamItem[] = [];
          for (let i = 0; i < state.length; i++) {
            next.push(state[i]);
          }
          const existing: ToolCallItem = next[existingIdx] as ToolCallItem;
          const updated: ToolCallItem = {
            kind: 'tool_call',
            id: existing.id,
            timestamp: timestamp,
            callId: existing.callId,
            provider: existing.provider,
            name: existing.name,
            status: (item.status !== undefined ? item.status : existing.status) as AgentToolCallStatus,
            detail: item.detail !== undefined ? item.detail : existing.detail,
          };
          next[existingIdx] = updated;
          return next;
        }
      }
      const tc: ToolCallItem = buildToolCall(item, timestamp);
      tc.provider = event.provider;
      const next: StreamItem[] = [];
      for (let i = 0; i < state.length; i++) {
        next.push(state[i]);
      }
      next.push(tc);
      return next;
    }

    case 'error': {
      const next: StreamItem[] = [];
      for (let i = 0; i < state.length; i++) {
        next.push(state[i]);
      }
      return appendStreamItem(next, buildActivityLog(item, timestamp));
    }

    case 'turn':
      return state;

    default:
      return state;
  }
}

export interface HydrateStreamEntry {
  event: TimelineEvent;
  timestamp: number;
}

export function hydrateStreamState(
  events: HydrateStreamEntry[],
): StreamItem[] {
  let state: StreamItem[] = [];
  for (let ei = 0; ei < events.length; ei++) {
    const entry = events[ei];
    state = reduceStreamUpdate(state, entry.event, entry.timestamp);
  }
  return state;
}

// Timeline response types
export interface TimelineResponsePayload {
  agentId: string;
  direction: 'tail' | 'before' | 'after';
  reset: boolean;
  epoch: string;
  startSeq: number | null;
  endSeq: number | null;
  entries: TimelineResponseEntry[];
  error: string | null;
  hasNewer: boolean;
  hasOlder: boolean;
}

export interface TimelineResponseEntry {
  seqStart: number;
  seqEnd: number;
  provider: string;
  item: ESObject;
  timestamp: string;
}

export interface ProcessTimelineInput {
  payload: TimelineResponsePayload;
  currentTail: StreamItem[];
  currentHead: StreamItem[];
  currentCursor: TimelineCursor | undefined;
}

export interface ProcessTimelineOutput {
  tail: StreamItem[];
  head: StreamItem[];
  cursor: TimelineCursor | undefined;
  cursorChanged: boolean;
  error: string | null;
  hasMore: boolean;
}

function shouldAcceptSeq(
  cursor: TimelineCursor | undefined,
  epoch: string,
  seq: number,
): 'accept' | 'drop' | 'gap' {
  if (cursor === undefined) {
    return 'accept';
  }
  if (cursor.epoch !== epoch) {
    return 'drop';
  }
  if (seq <= cursor.endSeq) {
    return 'drop';
  }
  if (seq > cursor.endSeq + 1) {
    return 'gap';
  }
  return 'accept';
}

function copyArray<T>(arr: T[]): T[] {
  const result: T[] = [];
  for (let i = 0; i < arr.length; i++) {
    result.push(arr[i]);
  }
  return result;
}

export function processTimelineResponse(input: ProcessTimelineInput): ProcessTimelineOutput {
  const payload: TimelineResponsePayload = input.payload;
  const currentTail: StreamItem[] = input.currentTail;
  const currentHead: StreamItem[] = input.currentHead;
  const currentCursor: TimelineCursor | undefined = input.currentCursor;

  if (payload.error !== null) {
    const output: ProcessTimelineOutput = {
      tail: currentTail,
      head: currentHead,
      cursor: currentCursor,
      cursorChanged: false,
      error: payload.error,
      hasMore: false,
    };
    return output;
  }

  if (payload.entries === undefined || payload.entries.length === 0) {
    const output: ProcessTimelineOutput = {
      tail: currentTail,
      head: currentHead,
      cursor: currentCursor,
      cursorChanged: false,
      error: null,
      hasMore: false,
    };
    return output;
  }

  const hydrated: HydratedEntry[] = [];
  for (let ei = 0; ei < payload.entries.length; ei++) {
    const entry = payload.entries[ei];
    const timelineEvent: TimelineEvent = {
      provider: entry.provider,
      item: entry.item as TimelineEventItem,
    };
    const hydratedEntry: HydratedEntry = {
      event: timelineEvent,
      timestamp: new Date(entry.timestamp).getTime(),
      seq: entry.seqStart,
    };
    hydrated.push(hydratedEntry);
  }

  // Case 1: Initial load (no cursor) or reset
  if (currentCursor === undefined || payload.reset) {
    const batchEntries: HydrateStreamEntry[] = [];
    for (let bi = 0; bi < hydrated.length; bi++) {
      const h: HydratedEntry = hydrated[bi];
      const entry: HydrateStreamEntry = { event: h.event, timestamp: h.timestamp };
      batchEntries.push(entry);
    }
    const newTail: StreamItem[] = hydrateStreamState(batchEntries);
    const firstSeq: number = hydrated.length > 0 ? hydrated[0].seq : 1;
    const lastSeq: number = hydrated.length > 0 ? hydrated[hydrated.length - 1].seq : 1;
    const newCursor: TimelineCursor = {
      epoch: payload.epoch,
      startSeq: payload.startSeq !== null ? payload.startSeq : firstSeq,
      endSeq: payload.endSeq !== null ? payload.endSeq : lastSeq,
    };

    const output: ProcessTimelineOutput = {
      tail: newTail,
      head: [],
      cursor: newCursor,
      cursorChanged: true,
      error: null,
      hasMore: payload.hasNewer,
    };
    return output;
  }

  // Case 2: Incremental append
  let nextTail: StreamItem[] = copyArray(currentTail);
  let nextHead: StreamItem[] = copyArray(currentHead);
  let nextCursor: TimelineCursor = {
    epoch: currentCursor.epoch,
    startSeq: currentCursor.startSeq,
    endSeq: currentCursor.endSeq,
  };
  let acceptedCount = 0;

  for (let ei = 0; ei < hydrated.length; ei++) {
    const entry: HydratedEntry = hydrated[ei];
    const decision: 'accept' | 'drop' | 'gap' = shouldAcceptSeq(nextCursor, payload.epoch, entry.seq);

    if (decision === 'accept') {
      if (nextHead.length > 0) {
        nextHead = reduceStreamUpdate(nextHead, entry.event, entry.timestamp);
      } else {
        nextTail = reduceStreamUpdate(nextTail, entry.event, entry.timestamp);
      }
      nextCursor.endSeq = entry.seq;
      acceptedCount += 1;
    } else if (decision === 'gap') {
      if (nextHead.length > 0) {
        nextHead = reduceStreamUpdate(nextHead, entry.event, entry.timestamp);
      } else {
        nextTail = reduceStreamUpdate(nextTail, entry.event, entry.timestamp);
      }
      nextCursor.endSeq = entry.seq;
      acceptedCount += 1;
    }
    // 'drop' — silently skip
  }

  // Trim head to max size
  if (nextHead.length > MAX_HEAD_SIZE) {
    const overflow: number = nextHead.length - MAX_HEAD_SIZE;
    for (let i = 0; i < overflow; i++) {
      nextTail.push(nextHead[i]);
    }
    const trimmedHead: StreamItem[] = [];
    for (let i = overflow; i < nextHead.length; i++) {
      trimmedHead.push(nextHead[i]);
    }
    nextHead = trimmedHead;
  }

  const cursorChanged: boolean = acceptedCount > 0;

  const output: ProcessTimelineOutput = {
    tail: nextTail,
    head: nextHead,
    cursor: nextCursor,
    cursorChanged: cursorChanged,
    error: null,
    hasMore: payload.hasNewer,
  };
  return output;
}
