import type { Logger } from "pino";

import {
  type ACPDelegationExtension,
  type ACPDelegationRow,
  type ACPDelegationTree,
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
 * reporting it as running would claim work the provider did not report. The
 * member stays in the tree, so a row it had keeps its place.
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
function readMiniMaxCodeTree(tree: unknown): ACPDelegationTree | null {
  const members = readMiniMaxCodeMembers(tree);
  if (!members) {
    return null;
  }
  const memberIds = members.map((member) => member.sessionId);
  const memberIdSet = new Set(memberIds);
  const rows: ACPDelegationRow[] = [];
  for (const member of members) {
    const status = readMiniMaxCodeMemberStatus(member.status);
    if (!status) {
      // The provider reports a status Paseo cannot show. The member stays in
      // the tree, so the row it had is not removed.
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
    rows.push(row);
  }
  return { rows, memberIds };
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
    return readMiniMaxCodeTree(result);
  },
  parseUpdate(params) {
    return readMiniMaxCodeTree(params.snapshot);
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
