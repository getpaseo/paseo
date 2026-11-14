// COMPAT(timelineRewindOperations): added in v0.14.1, remove after 2027-05-10 once the client floor
// applies rewinds. Delete this module and its call sites in session.ts.
//
// A client without the capability cannot drop retired rows from what it already holds. The only
// signal it honors is an epoch change, so it sees each retirement as a new history: the stored
// epoch, suffixed with the retirement count once there is one. Nothing is stored or rotated.

import type { AgentTimelineCursor } from "../../agent/agent-timeline-store-types.js";

const RETIREMENT_SUFFIX = /^(.*)\.r([1-9][0-9]*)$/;

/** The epoch a client without rewind operations sees for a history. */
export function legacyWireEpoch(epoch: string, retirementCount: number): string {
  return retirementCount === 0 ? epoch : `${epoch}.r${retirementCount}`;
}

/**
 * Reads a cursor such a client sends back. It stays valid only while no retirement has happened
 * since, so the timeline treats a later retirement as a stale cursor and resets the client.
 */
export function readLegacyWireCursor(cursor: { epoch: string; seq: number }): AgentTimelineCursor {
  const match = RETIREMENT_SUFFIX.exec(cursor.epoch);
  return match
    ? { epoch: match[1], seq: cursor.seq, retirementCount: Number(match[2]) }
    : { epoch: cursor.epoch, seq: cursor.seq, retirementCount: 0 };
}
