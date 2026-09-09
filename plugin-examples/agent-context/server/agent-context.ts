import type { PluginAttachmentSearchPayload, RpcInput } from "@getpaseo/plugin";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { searchAgentTranscriptsRpc } from "../shared/agent-context";

const DIRECTORY_PAGE_SIZE = 200;
const MAX_AGENTS_SCANNED = 1_000;
const MAX_SEARCH_RESULTS = 5;
const TIMELINE_PAGE_SIZE = 200;
const MAX_TIMELINE_ITEMS_SCANNED = 5_000;
const MAX_TIMELINE_PAGES_SCANNED = 25;
export const MAX_TRANSCRIPT_BYTES = 128 * 1024;
const PARENT_AGENT_ID_LABEL = "paseo.parent-agent-id";
const PLUGIN_DOCUMENTATION_URL =
  "https://github.com/getpaseo/paseo/tree/main/plugin-examples/agent-context";

interface AgentSummary {
  id: string;
  title: string | null;
  provider: string;
  cwd: string;
  updatedAt: string;
  archivedAt?: string | null;
  labels: Record<string, string>;
}

interface ProjectPlacement {
  projectName: string;
  workspaceName?: string | null;
}

interface AgentDirectoryEntry {
  agent: AgentSummary;
  project: ProjectPlacement;
}

interface AgentDirectoryPage {
  entries: AgentDirectoryEntry[];
  pageInfo: { nextCursor: string | null };
}

interface TimelineCursor {
  epoch: string;
  seq: number;
}

interface TimelinePage {
  epoch: string;
  staleCursor: boolean;
  hasOlder: boolean;
  startCursor: TimelineCursor | null;
  entries: Array<{ item: unknown }>;
  error: string | null;
}

export interface AgentContextSearchDependencies {
  listAgents(options: {
    sort: Array<{ key: "updated_at"; direction: "desc" }>;
    page: { limit: number; cursor?: string };
  }): Promise<AgentDirectoryPage>;
  fetchTimeline(
    agentId: string,
    options: {
      direction: "tail" | "before";
      cursor?: TimelineCursor;
      limit: number;
      projection: "projected";
    },
  ): Promise<TimelinePage>;
  now(): Date;
}

interface TranscriptMetadata {
  agent: AgentSummary;
  project: ProjectPlacement;
  capturedAt: Date;
}

interface TranscriptChunk {
  label: "User" | "Assistant" | "Tool";
  text: string;
}

interface TimelineSnapshot {
  items: unknown[];
  olderItemsOmitted: boolean;
}

interface RankedAgent {
  entry: AgentDirectoryEntry;
  score: number;
}

function normalizeSearchValue(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function singleLine(value: string | null | undefined, maxCharacters = 512): string | null {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  if (normalized.length <= maxCharacters) return normalized;
  return `${normalized.slice(0, maxCharacters - 1)}…`;
}

function isTopLevelAgent(agent: AgentSummary): boolean {
  return !agent.archivedAt && !agent.labels[PARENT_AGENT_ID_LABEL]?.trim();
}

function scoreAgent(entry: AgentDirectoryEntry, normalizedQuery: string): number | null {
  if (!normalizedQuery) return 0;
  const fields = [
    normalizeSearchValue(entry.agent.title),
    normalizeSearchValue(entry.project.workspaceName),
    normalizeSearchValue(entry.project.projectName),
    normalizeSearchValue(entry.agent.cwd),
    normalizeSearchValue(entry.agent.provider),
    normalizeSearchValue(entry.agent.id),
  ];
  let best = Number.POSITIVE_INFINITY;
  for (const [index, value] of fields.entries()) {
    if (!value) continue;
    if (value === normalizedQuery) best = Math.min(best, index * 3);
    else if (value.startsWith(normalizedQuery)) best = Math.min(best, index * 3 + 1);
    else if (value.includes(normalizedQuery)) best = Math.min(best, index * 3 + 2);
  }
  return Number.isFinite(best) ? best : null;
}

function updatedAtMs(entry: AgentDirectoryEntry): number {
  const value = Date.parse(entry.agent.updatedAt);
  return Number.isNaN(value) ? 0 : value;
}

function compareStableText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

async function findAgents(
  dependencies: AgentContextSearchDependencies,
  query: string,
): Promise<AgentDirectoryEntry[]> {
  const normalizedQuery = normalizeSearchValue(query);
  const ranked: RankedAgent[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  let scanned = 0;

  while (scanned < MAX_AGENTS_SCANNED) {
    const page = await dependencies.listAgents({
      sort: [{ key: "updated_at", direction: "desc" }],
      page: {
        limit: Math.min(DIRECTORY_PAGE_SIZE, MAX_AGENTS_SCANNED - scanned),
        ...(cursor ? { cursor } : {}),
      },
    });
    scanned += page.entries.length;
    for (const entry of page.entries) {
      if (seen.has(entry.agent.id) || !isTopLevelAgent(entry.agent)) continue;
      seen.add(entry.agent.id);
      const score = scoreAgent(entry, normalizedQuery);
      if (score !== null) ranked.push({ entry, score });
    }

    const nextCursor = page.pageInfo.nextCursor?.trim();
    if (!nextCursor || nextCursor === cursor || page.entries.length === 0) break;
    cursor = nextCursor;
  }

  return ranked
    .sort(
      (left, right) =>
        left.score - right.score ||
        updatedAtMs(right.entry) - updatedAtMs(left.entry) ||
        compareStableText(left.entry.agent.id, right.entry.agent.id),
    )
    .slice(0, MAX_SEARCH_RESULTS)
    .map(({ entry }) => entry);
}

function objectValue(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
}

function textValue(item: unknown): string | null {
  const value = objectValue(item, "text");
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function safeToolKind(item: unknown): string {
  const detailType = objectValue(objectValue(item, "detail"), "type");
  switch (detailType) {
    case "shell":
      return "Shell";
    case "read":
      return "Read";
    case "edit":
      return "Edit";
    case "write":
      return "Write";
    case "search":
      return "Search";
    case "fetch":
      return "Fetch";
    case "worktree_setup":
      return "Worktree setup";
    case "sub_agent":
      return "Subagent";
    case "plan":
      return "Plan";
    default:
      return "Activity";
  }
}

function transcriptChunk(item: unknown): TranscriptChunk | null {
  const type = objectValue(item, "type");
  if (type === "user_message") {
    const text = textValue(item);
    return text ? { label: "User", text } : null;
  }
  if (type === "assistant_message") {
    const text = textValue(item);
    return text ? { label: "Assistant", text } : null;
  }
  if (type === "tool_call") {
    return { label: "Tool", text: safeToolKind(item) };
  }
  return null;
}

function renderChunk(chunk: TranscriptChunk): string {
  return chunk.label === "Tool" ? `[Tool: ${chunk.text}]` : `[${chunk.label}] ${chunk.text}`;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function takeUtf8Suffix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const characters = Array.from(value);
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (byteLength(characters.slice(middle).join("")) <= maxBytes) high = middle;
    else low = middle + 1;
  }
  return characters.slice(low).join("");
}

function truncateChunk(chunk: TranscriptChunk, maxBytes: number): string {
  const marker = `[${chunk.label}] [Earlier content in this message omitted]\n`;
  const markerBytes = byteLength(marker);
  if (markerBytes >= maxBytes) return takeUtf8Suffix(marker, maxBytes);
  return `${marker}${takeUtf8Suffix(chunk.text, maxBytes - markerBytes)}`;
}

function selectRecentChunks(
  chunks: TranscriptChunk[],
  maxBytes: number,
): { body: string; omitted: boolean } {
  const selected: string[] = [];
  let usedBytes = 0;
  let omitted = false;

  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    const rendered = renderChunk(chunks[index]);
    const separatorBytes = selected.length > 0 ? 1 : 0;
    const renderedBytes = byteLength(rendered);
    if (usedBytes + separatorBytes + renderedBytes <= maxBytes) {
      selected.push(rendered);
      usedBytes += separatorBytes + renderedBytes;
      continue;
    }
    omitted = true;
    if (selected.length === 0) {
      selected.push(truncateChunk(chunks[index], maxBytes));
    }
    break;
  }

  return { body: selected.toReversed().join("\n"), omitted };
}

function transcriptHeader(metadata: TranscriptMetadata, truncated: boolean): string {
  const title = singleLine(metadata.agent.title) ?? `Agent ${shortAgentId(metadata.agent.id)}`;
  const lines = [
    "<chat-history-summary>",
    "Chat history snapshot from a previous Paseo agent.",
    `Captured: ${metadata.capturedAt.toISOString()}`,
    `Source agent: ${title}`,
    `Source agent ID: ${singleLine(metadata.agent.id) ?? "Unknown"}`,
    `Source provider: ${singleLine(metadata.agent.provider) ?? "Unknown"}`,
  ];
  const workspace = singleLine(metadata.project.workspaceName);
  const project = singleLine(metadata.project.projectName);
  const cwd = singleLine(metadata.agent.cwd);
  if (workspace) lines.push(`Source workspace: ${workspace}`);
  if (project) lines.push(`Source project: ${project}`);
  if (cwd) lines.push(`Source directory: ${cwd}`);
  if (truncated) lines.push("Earlier context was omitted to fit the snapshot size limit.");
  return `${lines.join("\n")}\n\n`;
}

export function buildTranscriptSnapshot(input: {
  items: unknown[];
  metadata: TranscriptMetadata;
  olderItemsOmitted?: boolean;
}): string {
  const chunks = input.items.flatMap((item) => {
    const chunk = transcriptChunk(item);
    return chunk ? [chunk] : [];
  });
  const closing = "\n</chat-history-summary>";
  const completeHeader = transcriptHeader(input.metadata, false);
  const completeBody = chunks.map(renderChunk).join("\n") || "No shareable activity was found.";
  if (
    !input.olderItemsOmitted &&
    byteLength(`${completeHeader}${completeBody}${closing}`) <= MAX_TRANSCRIPT_BYTES
  ) {
    return `${completeHeader}${completeBody}${closing}`;
  }

  const truncatedHeader = transcriptHeader(input.metadata, true);
  const bodyBudget = Math.max(
    0,
    MAX_TRANSCRIPT_BYTES - byteLength(truncatedHeader) - byteLength(closing),
  );
  const selection = selectRecentChunks(chunks, bodyBudget);
  const body = selection.body || "No shareable activity was found.";
  return `${truncatedHeader}${body}${closing}`;
}

async function readTimelineSnapshot(
  dependencies: AgentContextSearchDependencies,
  agentId: string,
): Promise<TimelineSnapshot> {
  const pages: unknown[][] = [];
  const seenCursors = new Set<string>();
  let cursor: TimelineCursor | undefined;
  let expectedEpoch: string | null = null;
  let scanned = 0;
  let pagesScanned = 0;
  let shareableBytes = 0;
  let olderItemsOmitted = false;

  while (scanned < MAX_TIMELINE_ITEMS_SCANNED) {
    const page = await dependencies.fetchTimeline(agentId, {
      direction: cursor ? "before" : "tail",
      ...(cursor ? { cursor } : {}),
      limit: Math.min(TIMELINE_PAGE_SIZE, MAX_TIMELINE_ITEMS_SCANNED - scanned),
      projection: "projected",
    });
    pagesScanned += 1;
    if (page.error) throw new Error(page.error);
    if (page.staleCursor || (expectedEpoch !== null && page.epoch !== expectedEpoch)) {
      throw new Error("The source timeline changed while its snapshot was being captured");
    }
    expectedEpoch = page.epoch;
    pages.unshift(page.entries.map(({ item }) => item));
    scanned += page.entries.length;
    for (const { item } of page.entries) {
      const chunk = transcriptChunk(item);
      if (chunk) shareableBytes += byteLength(renderChunk(chunk)) + 1;
    }

    if (!page.hasOlder) break;
    if (
      shareableBytes >= MAX_TRANSCRIPT_BYTES ||
      scanned >= MAX_TIMELINE_ITEMS_SCANNED ||
      pagesScanned >= MAX_TIMELINE_PAGES_SCANNED
    ) {
      olderItemsOmitted = true;
      break;
    }
    if (!page.startCursor) {
      olderItemsOmitted = true;
      break;
    }
    const cursorKey = `${page.startCursor.epoch}:${page.startCursor.seq}`;
    if (seenCursors.has(cursorKey)) {
      olderItemsOmitted = true;
      break;
    }
    seenCursors.add(cursorKey);
    cursor = page.startCursor;
  }

  return { items: pages.flat(), olderItemsOmitted };
}

function shortAgentId(agentId: string): string {
  const withoutPrefix = agentId.startsWith("agent_") ? agentId.slice("agent_".length) : agentId;
  return withoutPrefix.slice(0, 8) || agentId;
}

function subtitle(entry: AgentDirectoryEntry): string | undefined {
  const values = [
    singleLine(entry.project.workspaceName, 80),
    singleLine(entry.project.projectName, 80),
    singleLine(entry.agent.provider, 80),
  ].filter((value): value is string => Boolean(value));
  const unique = [...new Set(values)];
  return unique.length > 0 ? unique.join(" · ") : undefined;
}

async function mapWithConcurrency<Input, Output>(
  inputs: Input[],
  limit: number,
  transform: (input: Input) => Promise<Output>,
): Promise<Array<PromiseSettledResult<Output>>> {
  const results = new Map<number, PromiseSettledResult<Output>>();
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < inputs.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results.set(index, { status: "fulfilled", value: await transform(inputs[index]) });
      } catch (reason) {
        results.set(index, { status: "rejected", reason });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, inputs.length) }, worker));
  return inputs.map((_, index) => {
    const result = results.get(index);
    if (!result) throw new Error("Agent transcript search worker stopped unexpectedly");
    return result;
  });
}

export function createAgentTranscriptSearch(dependencies: AgentContextSearchDependencies) {
  return async ({
    query,
  }: RpcInput<typeof searchAgentTranscriptsRpc>): Promise<PluginAttachmentSearchPayload> => {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) return { items: [] };
    const candidates = await findAgents(dependencies, normalizedQuery);
    const capturedAt = dependencies.now();
    const snapshots = await mapWithConcurrency(candidates, 2, async (entry) => {
      const timeline = await readTimelineSnapshot(dependencies, entry.agent.id);
      const title = singleLine(entry.agent.title, 160) ?? `Agent ${shortAgentId(entry.agent.id)}`;
      const sourceSubtitle = subtitle(entry);
      return {
        id: entry.agent.id,
        identifier: shortAgentId(entry.agent.id),
        title,
        ...(sourceSubtitle ? { subtitle: sourceSubtitle } : {}),
        url: PLUGIN_DOCUMENTATION_URL,
        text: buildTranscriptSnapshot({
          items: timeline.items,
          metadata: { ...entry, capturedAt },
          olderItemsOmitted: timeline.olderItemsOmitted,
        }),
        resourceType: "agent transcript",
      };
    });
    const items = snapshots.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    if (items.length === 0) {
      const firstFailure = snapshots.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (firstFailure) throw firstFailure.reason;
    }
    return { items };
  };
}

export async function searchAgentTranscripts(
  input: RpcInput<typeof searchAgentTranscriptsRpc>,
  { paseo }: PluginHandlerContext,
): Promise<PluginAttachmentSearchPayload> {
  const search = createAgentTranscriptSearch({
    listAgents: (options) => paseo.agents.list(options),
    fetchTimeline: (agentId, options) => paseo.agents.ref(agentId).timeline.refetch(options),
    now: () => new Date(),
  });
  return search(input);
}
