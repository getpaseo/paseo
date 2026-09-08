import { createPaseoApi } from "@getpaseo/client";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import type { CommandError, CommandOptions } from "../../output/index.js";

export interface TerminalCommandOptions extends CommandOptions {
  host?: string;
}

interface TerminalLike {
  id: string;
  name?: string | null;
}

export async function connectTerminalClient(host?: string) {
  const daemonHost = getDaemonHost({ host });
  try {
    const client = await connectToDaemon({ host });
    return { client: createPaseoApi(client), daemonHost, close: () => client.close() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const error: CommandError = {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${daemonHost}: ${message}`,
      details: "Start the daemon with: paseo daemon start",
    };
    throw error;
  }
}

export function toTerminalCommandError(code: string, action: string, err: unknown): CommandError {
  if (err && typeof err === "object" && "code" in err && "message" in err) {
    return err as CommandError;
  }

  const message = err instanceof Error ? err.message : String(err);
  const rpcCode =
    typeof err === "object" && err !== null && "code" in err && typeof err.code === "string"
      ? err.code
      : undefined;

  return {
    code: rpcCode ?? code,
    message: `Failed to ${action}: ${message}`,
  };
}

export async function resolveTerminalId(
  client: Awaited<ReturnType<typeof connectTerminalClient>>["client"],
  idOrName: string,
): Promise<string | null> {
  const payload = await client.terminals.list();
  return resolveTerminalIdentifier(idOrName, payload.entries);
}

function resolveTerminalIdentifier(idOrName: string, terminals: TerminalLike[]): string | null {
  if (!idOrName || terminals.length === 0) {
    return null;
  }

  const query = idOrName.toLowerCase();

  const exactMatch = terminals.find((terminal) => terminal.id === idOrName);
  if (exactMatch) {
    return exactMatch.id;
  }

  const prefixMatches = terminals.filter((terminal) => terminal.id.toLowerCase().startsWith(query));
  if (prefixMatches.length === 1 && prefixMatches[0]) {
    return prefixMatches[0].id;
  }
  if (prefixMatches.length > 1) {
    return null;
  }

  const nameMatches = terminals.filter((terminal) => terminal.name?.toLowerCase() === query);
  if (nameMatches.length === 1 && nameMatches[0]) {
    return nameMatches[0].id;
  }

  const partialNameMatches = terminals.filter((terminal) =>
    terminal.name?.toLowerCase().includes(query),
  );
  if (partialNameMatches.length === 1 && partialNameMatches[0]) {
    return partialNameMatches[0].id;
  }

  return null;
}
