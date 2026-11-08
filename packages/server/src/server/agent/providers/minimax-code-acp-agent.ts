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
  createdAtMs: number | null;
  updatedAtMs: number | null;
}

/**
 * Reads the members of a delegation tree.
 *
 * The provider sends the whole tree, not a diff. A member without a session id
 * cannot be addressed and is skipped.
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
      continue;
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
      createdAtMs: typeof entry.createdAtMs === "number" ? entry.createdAtMs : null,
      updatedAtMs: typeof entry.updatedAtMs === "number" ? entry.updatedAtMs : null,
    });
  }
  return parsed;
}

/**
 * Reads the status of one member.
 *
 * MiniMax Code reports `running`, `completed` and `stopped` for a
 * delegated member. A status outside that vocabulary says nothing about the
 * work being finished, so the member stays visible as running rather than
 * claiming an end the provider did not report.
 *
 * The provider can also project a member that has not started yet as finished,
 * with the same timestamp for its creation and its last update. It takes the
 * member back to running a moment later, so a finished member without any
 * observed progress stays running: reporting it as finished would claim the
 * work is done before it began.
 */
function readMiniMaxCodeMemberStatus(member: MiniMaxCodeDelegationMember): ProviderSubagentStatus {
  if (member.status === "completed") {
    const neverProgressed =
      member.createdAtMs !== null &&
      member.updatedAtMs !== null &&
      member.createdAtMs === member.updatedAtMs;
    return neverProgressed ? "running" : "completed";
  }
  if (member.status === "stopped") {
    return "canceled";
  }
  return "running";
}

/**
 * Turns the members of a tree into the rows the track shows.
 */
function readMiniMaxCodeRows(tree: unknown): ACPDelegationRow[] | null {
  const members = readMiniMaxCodeMembers(tree);
  if (!members) {
    return null;
  }
  const memberIds = new Set(members.map((member) => member.sessionId));
  return members.map((member) => {
    const row: ACPDelegationRow = {
      id: member.sessionId,
      // The track names the row after the task and demotes the agent name.
      title: member.agentName,
      description: member.task,
      status: readMiniMaxCodeMemberStatus(member),
      parentSubagentId:
        member.parentSessionId && memberIds.has(member.parentSessionId)
          ? member.parentSessionId
          : null,
    };
    if (member.updatedAtMs !== null) {
      row.timestamp = new Date(member.updatedAtMs).toISOString();
    }
    return row;
  });
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
  parseUpdate(params) {
    return readMiniMaxCodeRows(params.snapshot);
  },
};

interface MiniMaxCodeACPAgentClientOptions {
  logger: Logger;
  command: [string, ...string[]];
  env?: Record<string, string>;
  providerId?: string;
  label?: string;
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
      clientCapabilityMeta: MINIMAX_CODE_CLIENT_CAPABILITY_META,
      delegationExtension: MINIMAX_CODE_DELEGATION_EXTENSION,
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
