import { renderTomlTable } from "./toml-stringify.js";

/**
 * Merge our `[mcp_servers.<name>]` blocks into a user's existing config.toml
 * without disturbing other tables. We treat the file as line-grouped blocks
 * delimited by `[header]` lines and rewrite only the ones we own.
 *
 * `previousOwnedKeys` are keys we wrote on the previous sync — they get
 * dropped if no longer in `nextEntries`. Any `mcp_servers.<key>` block whose
 * key was never owned by us is left intact (the user added it manually).
 */
export interface CodexEntry {
  key: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface Block {
  /** Header line, e.g. "[mcp_servers.playwright]" or undefined for preamble. */
  header: string | undefined;
  /** All lines including the header line itself. */
  lines: string[];
}

function parseBlocks(source: string): Block[] {
  const lines = source.split(/\r?\n/);
  const blocks: Block[] = [{ header: undefined, lines: [] }];
  for (const raw of lines) {
    const line = raw;
    const isHeader = /^\s*\[[^\]]+\]\s*$/.test(line);
    if (isHeader) {
      blocks.push({ header: line.trim(), lines: [line] });
    } else {
      blocks[blocks.length - 1]!.lines.push(line);
    }
  }
  return blocks;
}

function headerKey(header: string | undefined): string | null {
  if (!header) return null;
  const match = header.match(/^\[mcp_servers\.([^\]]+)\]$/);
  return match ? match[1]! : null;
}

export function mergeCodexConfig(args: {
  previousSource: string;
  nextEntries: CodexEntry[];
  previousOwnedKeys: string[];
}): string {
  const { previousSource, nextEntries, previousOwnedKeys } = args;
  const ownedSet = new Set(previousOwnedKeys);
  const nextKeys = new Set(nextEntries.map((e) => e.key));

  const blocks = parseBlocks(previousSource);
  const kept: Block[] = [];
  for (const block of blocks) {
    const mcpKey = headerKey(block.header);
    if (mcpKey === null) {
      kept.push(block);
      continue;
    }
    if (ownedSet.has(mcpKey)) {
      // Drop — we'll re-emit if it's still active, otherwise it's gone.
      continue;
    }
    if (nextKeys.has(mcpKey)) {
      // User-added block with same key as a new sync entry — keep theirs and
      // skip ours to avoid clobbering.
      kept.push(block);
    } else {
      kept.push(block);
    }
  }

  let out = kept
    .map((b) => b.lines.join("\n"))
    .join("\n")
    .replace(/\n+$/, "");

  const userManagedKeys = new Set(
    blocks
      .map((b) => headerKey(b.header))
      .filter((k): k is string => k !== null && !ownedSet.has(k)),
  );

  const renderedBlocks: string[] = [];
  for (const entry of nextEntries) {
    if (userManagedKeys.has(entry.key)) continue;
    const data: Record<string, unknown> = { command: entry.command };
    if (entry.args && entry.args.length > 0) data.args = entry.args;
    if (entry.env && Object.keys(entry.env).length > 0) data.env = entry.env;
    renderedBlocks.push(renderTomlTable(["mcp_servers", entry.key], data));
  }

  if (renderedBlocks.length > 0) {
    if (out.length > 0) out += "\n\n";
    out += renderedBlocks.join("\n\n");
  }

  return out.endsWith("\n") ? out : out + "\n";
}
