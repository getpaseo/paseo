import type { Logger } from "pino";

import {
  type ACPDelegationExtension,
  type ACPDelegationRow,
  type ACPClientCapabilityMeta,
} from "./acp-agent.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";
import type { ProviderSubagentStatus } from "../provider-subagents/store.js";

/**
 * The provider id the ACP catalog gives MiniMax Code.
 */
export const MINIMAX_CODE_PROVIDER_ID = "minimax-code";

/**
 * The command names MiniMax Code answers to.
 *
 * The catalog runs it through npx, so its binary appears as an argument of its
 * own. The comparison is exact: a provider whose name merely contains these
 * words - `dimcode` for one - is a different agent.
 */
const MINIMAX_CODE_COMMAND_NAMES = new Set([MINIMAX_CODE_PROVIDER_ID, "mcode"]);

/**
 * The metadata key where MiniMax Code advertises the extension methods it
 * supports.
 */
const MINIMAX_CODE_EXTENSIONS_META_KEY = "minimax-code/extensions";

/**
 * The extension method that reads the delegation tree, and the notification
 * that publishes an updated one.
 */
const MINIMAX_CODE_DELEGATION_GET_METHOD = "mcode/session/delegation/get";
const MINIMAX_CODE_DELEGATION_UPDATE_NOTIFICATION = "mcode/session/delegation_update";

/**
 * How long a row waits when the provider reports a child as finished before
 * it started.
 *
 * The recorded traces show the provider publishing a member that was created
 * and updated at the same moment as finished, and taking it back 113ms and
 * 115ms later. Equal timestamps are the evidence for that pattern, not a proof
 * of the state of the member: they do not tell whether it ever ran, so the
 * row waits instead of claiming a finish. The wait covers the observed delay
 * with room to spare and stays short enough that a child that really finished
 * is shown without a delay a user notices. That delay is the price of the
 * heuristic: such a child appears one wait later.
 */
const MINIMAX_CODE_DELEGATION_CONFIRMATION_MS = 500;

/**
 * The handshake request that asks a MiniMax Code provider for its extension
 * notifications.
 *
 * Without the request the provider keeps its background work to itself: it
 * never publishes the tree of the sub-agents a session delegated to.
 */
export const MINIMAX_CODE_CLIENT_CAPABILITY_META: ACPClientCapabilityMeta = {
  [MINIMAX_CODE_EXTENSIONS_META_KEY]: { version: 1, notifications: true },
};

/**
 * Reports whether a provider is MiniMax Code.
 *
 * The provider id is the usual answer. A user may register the same command
 * under a name of their own, so the command is checked as well, by the exact
 * name of its binary.
 */
export function isMiniMaxCodeProvider(
  providerId: string | undefined,
  command: readonly string[] | undefined,
): boolean {
  if (providerId === MINIMAX_CODE_PROVIDER_ID) {
    return true;
  }
  return (command ?? []).some((part) => isMiniMaxCodeBinary(part));
}

/**
 * Reports whether a command part names the MiniMax Code binary.
 *
 * The catalog installs the binary through npx, so the part may carry a
 * package version. The name is compared exactly, never as a substring.
 */
function isMiniMaxCodeBinary(part: string): boolean {
  const binary = part.split("/").pop() ?? part;
  const name = binary.split("@")[0] ?? binary;
  return MINIMAX_CODE_COMMAND_NAMES.has(name);
}

/**
 * One member of the delegation tree MiniMax Code publishes.
 *
 * The shape is the provider's own: the session id of the child, the session id
 * of its parent, the name of the agent that runs it, the task it was given and
 * where it stands.
 */
interface MiniMaxCodeDelegationMember {
  sessionId: string;
  parentSessionId: string | null;
  agentName: string | null;
  task: string | null;
  status: string;
  updatedAtMs: number | null;
}

/**
 * Reads the status of one member.
 *
 * MiniMax Code reports `running`, `completed`, `failed` and `stopped` for
 * a delegated member. A member it reports with a status Paseo does not know -
 * `queued` for one - has no row: the subagent store has no state for it, and
 * reporting it as running would claim work the provider did not report.
 */
function readMiniMaxCodeMemberStatus(status: string): ProviderSubagentStatus | null {
  switch (status) {
    case "running":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "stopped":
      return "canceled";
    default:
      return null;
  }
}

/**
 * Reads the members of a delegation tree.
 *
 * The provider sends the whole tree, not a diff. A member that cannot be
 * addressed makes the tree unusable: a tree read in part would drop the rows
 * of the members it did not parse.
 */
function readMiniMaxCodeMembers(tree: unknown): MiniMaxCodeDelegationMember[] | null {
  if (!isRecord(tree)) {
    return null;
  }
  const members = tree.members;
  if (!Array.isArray(members)) {
    return null;
  }
  const parsed: MiniMaxCodeDelegationMember[] = [];
  for (const entry of members) {
    if (!isRecord(entry) || typeof entry.sessionId !== "string" || !entry.sessionId) {
      return null;
    }
    parsed.push({
      sessionId: entry.sessionId,
      parentSessionId:
        typeof entry.parentSessionId === "string" && entry.parentSessionId
          ? entry.parentSessionId
          : null,
      agentName: typeof entry.agentName === "string" && entry.agentName ? entry.agentName : null,
      task: typeof entry.task === "string" && entry.task ? entry.task : null,
      status: typeof entry.status === "string" ? entry.status : "",
      updatedAtMs: typeof entry.updatedAtMs === "number" ? entry.updatedAtMs : null,
    });
  }
  return parsed;
}

/**
 * Turns a delegation tree into the rows the track shows.
 */
function readMiniMaxCodeRows(
  tree: unknown,
  knownMemberIds?: ReadonlySet<string>,
): ACPDelegationRow[] | null {
  const members = readMiniMaxCodeMembers(tree);
  if (!members) {
    return null;
  }
  const memberIdSet = new Set(members.map((member) => member.sessionId));
  const rows: ACPDelegationRow[] = [];
  for (const member of members) {
    const status = readMiniMaxCodeMemberStatus(member.status);
    if (!status) {
      // The provider reports a status Paseo cannot show. The member has no
      // row: the row it had is taken away rather than left showing a state
      // the provider has taken back.
      continue;
    }
    const row: ACPDelegationRow = {
      id: member.sessionId,
      // The track names the row after the task and demotes the agent name.
      title: member.agentName,
      description: member.task,
      status,
      parentSubagentId:
        member.parentSessionId && memberIdSet.has(member.parentSessionId)
          ? member.parentSessionId
          : null,
    };
    if (member.updatedAtMs !== null) {
      row.timestamp = new Date(member.updatedAtMs).toISOString();
    }
    if (knownMemberIds && status === "completed" && !knownMemberIds.has(member.sessionId)) {
      // The recorded traces show the provider publishing a member as finished
      // before it started it, and taking it back a moment later. That is a
      // pattern in the traces, not a rule of the protocol, so the row waits
      // instead of claiming a finish the provider may take back. A child the
      // session already showed is a child that ran, so its finish is shown at
      // once.
      //
      // The wait is what the heuristic costs: a child that really finished
      // appears one wait later, and a provider that reports a child as
      // finished without ever taking it back keeps the row hidden until the
      // wait is over.
      row.deferMs = MINIMAX_CODE_DELEGATION_CONFIRMATION_MS;
    }
    rows.push(row);
  }
  return rows;
}

/**
 * The delegation tree MiniMax Code publishes through its vendor extension.
 */
export const MINIMAX_CODE_DELEGATION_EXTENSION: ACPDelegationExtension = {
  advertisementKey: MINIMAX_CODE_EXTENSIONS_META_KEY,
  readMethod: MINIMAX_CODE_DELEGATION_GET_METHOD,
  updateMethod: MINIMAX_CODE_DELEGATION_UPDATE_NOTIFICATION,
  async readTree({ sessionId, connection }) {
    const response = await connection.extMethod(MINIMAX_CODE_DELEGATION_GET_METHOD, {
      sessionId,
    });
    return isRecord(response) ? response.snapshot : null;
  },
  parseReadResult(result) {
    return readMiniMaxCodeRows(result);
  },
  parseUpdate(params, context) {
    // A tree the session reads is the state of the world: a child that is
    // finished there is finished, and a resumed session shows it at once.
    // Only a tree the provider publishes while the session runs can report a
    // child that is not started yet.
    return readMiniMaxCodeRows(params.snapshot, context.knownMemberIds);
  },
};

interface MiniMaxCodeACPAgentClientOptions {
  logger: Logger;
  command: [string, ...string[]];
  env?: Record<string, string>;
  providerId?: string;
  label?: string;
  clientCapabilityMeta?: ACPClientCapabilityMeta;
}

/**
 * The ACP client for a MiniMax Code provider.
 *
 * It asks for the extension notifications the provider only sends to a client
 * that asked for them, and it publishes the delegation tree the provider
 * reports.
 */
export class MiniMaxCodeACPAgentClient extends GenericACPAgentClient {
  constructor(options: MiniMaxCodeACPAgentClientOptions) {
    super({
      ...options,
      // The vendor request joins the metadata of the caller: both belong in
      // the same handshake.
      clientCapabilityMeta: {
        ...options.clientCapabilityMeta,
        ...MINIMAX_CODE_CLIENT_CAPABILITY_META,
      },
      delegationExtension: MINIMAX_CODE_DELEGATION_EXTENSION,
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
