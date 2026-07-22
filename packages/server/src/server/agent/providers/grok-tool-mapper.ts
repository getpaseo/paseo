import type { ToolCallDetail } from "../agent-sdk-types.js";
import type { ACPToolSnapshot } from "./acp-agent.js";

/**
 * Grok ACP tool polish: map Task / TaskOutput tools onto existing Paseo detail
 * types so the timeline matches Claude/OMP/OpenCode norms.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    const text = readString(value);
    if (text) return text;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function extractTextFromContent(content: ACPToolSnapshot["content"]): string | null {
  if (!content?.length) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== "content") continue;
    const inner = asRecord(block.content);
    const text = readString(inner?.text);
    if (text) parts.push(text);
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

function asUnknownArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readRecordArray(value: unknown): Record<string, unknown>[] {
  return asUnknownArray(value).filter(isRecord);
}

function waitLabelForTaskIds(taskIds: unknown[]): string {
  if (taskIds.length === 0) return "Wait for subagents";
  return `Wait for ${taskIds.length} subagent${taskIds.length === 1 ? "" : "s"}`;
}

function extractTextFromRawOutput(rawOutput: unknown): string | null {
  if (typeof rawOutput === "string") return rawOutput.trim() || null;
  const record = asRecord(rawOutput);
  if (!record) return null;
  if (record.type === "Text") {
    return firstString(record.text, record.content);
  }
  return firstString(record.text, record.output, record.content);
}

function parseSubagentIdFromText(text: string | null): string | null {
  if (!text) return null;
  const match = text.match(/subagent_id:\s*([^\s\n]+)/i);
  return match?.[1]?.trim() || null;
}

function normalizeComparable(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/**
 * Drop instruction boilerplate and identity lines already shown in the
 * sub_agent header (type, description, session id).
 */
function stripSpawnLogNoise(
  text: string | null,
  fields: {
    childSessionId?: string | null;
    subAgentType?: string | null;
    description?: string | null;
  },
): string {
  if (!text) return "";
  const id = normalizeComparable(fields.childSessionId);
  const type = normalizeComparable(fields.subAgentType);
  const description = normalizeComparable(fields.description);
  const lines = text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      const lower = trimmed.toLowerCase();
      if (lower.startsWith("use get_command_or_subagent_output")) return false;
      if (lower.startsWith("use get_task_output")) return false;
      const idMatch = trimmed.match(/^subagent_id:\s*(.+)$/i);
      if (idMatch && (!id || normalizeComparable(idMatch[1]) === id)) return false;
      const typeMatch = trimmed.match(/^type:\s*(.+)$/i);
      // Only strip when we know the field value and it matches (avoid dropping unknown labels).
      if (typeMatch && type && normalizeComparable(typeMatch[1]) === type) return false;
      const descMatch = trimmed.match(/^description:\s*(.+)$/i);
      if (descMatch && description && normalizeComparable(descMatch[1]) === description) {
        return false;
      }
      return true;
    });
  return lines.join("\n").trim();
}

function isGrokTaskSpawn(
  snapshot: ACPToolSnapshot,
  input: Record<string, unknown> | null,
): boolean {
  const variant = firstString(input?.variant);
  if (variant === "Task") return true;
  const title = snapshot.title.trim().toLowerCase();
  if (title === "spawn_subagent" || title === "task") return true;
  if (
    input &&
    firstString(input.subagent_type, input.subagentType) &&
    firstString(input.prompt, input.description)
  ) {
    return true;
  }
  return false;
}

function isGrokTaskOutput(
  snapshot: ACPToolSnapshot,
  input: Record<string, unknown> | null,
  rawOutput: Record<string, unknown> | null,
): boolean {
  const variant = firstString(input?.variant);
  if (variant === "TaskOutput") return true;
  const title = snapshot.title.trim().toLowerCase();
  if (title === "get_command_or_subagent_output" || title.startsWith("get task output"))
    return true;
  if (title.startsWith("multi-wait")) return true;
  if (rawOutput?.type === "TaskOutput") return true;
  if (Array.isArray(input?.task_ids) || Array.isArray(input?.taskIds)) return true;
  return false;
}

function mapTaskSpawnDetail(
  snapshot: ACPToolSnapshot,
  input: Record<string, unknown> | null,
): ToolCallDetail {
  const text =
    extractTextFromContent(snapshot.content) ?? extractTextFromRawOutput(snapshot.rawOutput);
  const childSessionId =
    parseSubagentIdFromText(text) ??
    firstString(input?.task_id, input?.taskId, input?.subagent_id, input?.subagentId);
  const subAgentType =
    firstString(input?.subagent_type, input?.subagentType, input?.agent, input?.type) ?? undefined;
  const description =
    firstString(input?.description, snapshot.title !== "spawn_subagent" ? snapshot.title : null) ??
    undefined;
  const log = stripSpawnLogNoise(text, { childSessionId, subAgentType, description });
  return {
    type: "sub_agent",
    subAgentType,
    description,
    ...(childSessionId ? { childSessionId } : {}),
    log,
  };
}

function formatTaskResultLine(result: Record<string, unknown>): string {
  const id = firstString(result.task_id, result.taskId) ?? "task";
  const status = firstString(result.status) ?? "unknown";
  const command = firstString(result.command);
  const output = firstString(result.output);
  const shortOutput = output
    ? output
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0 && !line.startsWith("<subagent_meta"))
    : null;
  const label = command?.replace(/^\[subagent:[^\]]+\]\s*/i, "") ?? id.slice(0, 8);
  if (shortOutput) return `${status} · ${label} · ${shortOutput}`;
  return `${status} · ${label}`;
}

function collectTaskOutputResults(
  rawOutput: Record<string, unknown> | null,
): Record<string, unknown>[] {
  const multi = asRecord(rawOutput?.MultiResult) ?? asRecord(rawOutput?.multiResult);
  const fromMulti = readRecordArray(multi?.results);
  if (fromMulti.length > 0) return fromMulti;
  return readRecordArray(rawOutput?.results);
}

function taskOutputLines(
  results: Record<string, unknown>[],
  ids: unknown[],
  mode: string | null,
  snapshot: ACPToolSnapshot,
): string[] {
  if (results.length > 0) {
    const completed = results.filter((row) => firstString(row.status) === "completed").length;
    const header = mode
      ? `${completed}/${results.length} completed (${mode})`
      : `${completed}/${results.length} completed`;
    const lines = [header, ...results.slice(0, 8).map(formatTaskResultLine)];
    if (results.length > 8) {
      lines.push(`…and ${results.length - 8} more`);
    }
    return lines;
  }
  if (ids.length > 0) {
    return [`Waiting for ${ids.length} subagent${ids.length === 1 ? "" : "s"}`];
  }
  const text =
    extractTextFromContent(snapshot.content) ?? extractTextFromRawOutput(snapshot.rawOutput);
  return text ? [text] : [];
}

function mapTaskOutputDetail(
  snapshot: ACPToolSnapshot,
  input: Record<string, unknown> | null,
): ToolCallDetail {
  const rawOutput = asRecord(snapshot.rawOutput);
  const multi = asRecord(rawOutput?.MultiResult) ?? asRecord(rawOutput?.multiResult);
  const results = collectTaskOutputResults(rawOutput);
  const idsRaw = asUnknownArray(input?.task_ids);
  const ids = idsRaw.length > 0 ? idsRaw : asUnknownArray(input?.taskIds);
  const mode = firstString(multi?.mode, multi?.Mode);
  const lines = taskOutputLines(results, ids, mode, snapshot);
  // plain_text: label → row summary; text → expanded body.
  // Keep them distinct so the header is not "Multi Wait … multi-wait …".
  const summaryLine = lines[0] ?? waitLabelForTaskIds(ids);
  const bodyLines = lines.length > 1 ? lines.slice(1) : [];

  return {
    type: "plain_text",
    label: summaryLine,
    text: bodyLines.join("\n"),
    icon: "bot",
  };
}

/**
 * Grok backend web_search ACP rawInput nests fields under `action`:
 * `{ action: { type: "search", query, sources } }` — not top-level `query`.
 * Title is often the placeholder `Web search:` with the real query only in action.
 */
function isGrokWebSearch(
  snapshot: ACPToolSnapshot,
  input: Record<string, unknown> | null,
): boolean {
  const title = snapshot.title.trim().toLowerCase();
  if (title === "web search" || title.startsWith("web search:")) return true;
  if (snapshot.kind === "search" && asRecord(input?.action)?.query != null) return true;
  const actionType = firstString(asRecord(input?.action)?.type);
  return actionType === "search" && firstString(asRecord(input?.action)?.query) != null;
}

function queryFromWebSearchTitle(title: string): string | null {
  const match = title.match(/^web\s*search\s*:\s*(.+)$/i);
  const fromTitle = match?.[1]?.trim();
  return fromTitle && fromTitle.length > 0 ? fromTitle : null;
}

function isPlaceholderSearchQuery(query: string | null | undefined): boolean {
  if (!query) return true;
  const trimmed = query.trim();
  if (!trimmed) return true;
  // Bare ACP title fallback — not a real search string.
  return /^web\s*search\s*:?\s*$/i.test(trimmed) || /^search\s*:?\s*$/i.test(trimmed);
}

function extractGrokWebSearchQuery(
  snapshot: ACPToolSnapshot,
  input: Record<string, unknown> | null,
): string | null {
  const action = asRecord(input?.action);
  const fromAction = firstString(action?.query, action?.pattern, action?.q);
  if (fromAction) return fromAction;
  const fromTop = firstString(input?.query, input?.pattern, input?.q, input?.search);
  if (fromTop && !isPlaceholderSearchQuery(fromTop)) return fromTop;
  const fromTitle = queryFromWebSearchTitle(snapshot.title);
  if (fromTitle) return fromTitle;
  return null;
}

function extractGrokWebResults(
  input: Record<string, unknown> | null,
  rawOutput: Record<string, unknown> | null,
): Array<{ title: string; url: string }> {
  const action = asRecord(input?.action);
  const sourceLists = [
    asUnknownArray(action?.sources),
    asUnknownArray(input?.sources),
    asUnknownArray(rawOutput?.sources),
    asUnknownArray(asRecord(rawOutput?.action)?.sources),
  ];
  const results: Array<{ title: string; url: string }> = [];
  const seen = new Set<string>();
  for (const list of sourceLists) {
    for (const entry of list) {
      const row = asRecord(entry);
      if (!row) continue;
      const url = firstString(row.url, row.uri, row.href);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const title = firstString(row.title, row.name, row.site_name) ?? url;
      results.push({ title, url });
    }
  }
  return results;
}

function mapWebSearchDetail(
  snapshot: ACPToolSnapshot,
  input: Record<string, unknown> | null,
  defaultDetail: ToolCallDetail,
): ToolCallDetail {
  const rawOutput = asRecord(snapshot.rawOutput);
  const query = extractGrokWebSearchQuery(snapshot, input);
  const webResults = extractGrokWebResults(input, rawOutput);
  const content =
    extractTextFromContent(snapshot.content) ?? extractTextFromRawOutput(snapshot.rawOutput);

  // Prefer Grok-shaped search even when the generic mapper already returned
  // type "search" with a placeholder title as the query.
  if (!query && webResults.length === 0 && content == null) {
    return defaultDetail;
  }

  const resolvedQuery =
    query ??
    (defaultDetail.type === "search" && !isPlaceholderSearchQuery(defaultDetail.query)
      ? defaultDetail.query
      : null) ??
    (webResults.length > 0
      ? `${webResults.length} result${webResults.length === 1 ? "" : "s"}`
      : null) ??
    "Web search";

  return {
    type: "search",
    query: resolvedQuery,
    toolName: "web_search",
    ...(content ? { content } : {}),
    ...(webResults.length > 0 ? { webResults } : {}),
    ...(snapshot.locations?.length
      ? { filePaths: snapshot.locations.map((location) => location.path) }
      : {}),
  };
}

/**
 * Normalize titles so ACP display name is not a second copy of the wait summary.
 * Applied before detail mapping via toolSnapshotTransformer.
 */
export function transformGrokAcpToolSnapshot(snapshot: ACPToolSnapshot): ACPToolSnapshot {
  const input = asRecord(snapshot.rawInput);
  const rawOutput = asRecord(snapshot.rawOutput);
  if (!isGrokTaskOutput(snapshot, input, rawOutput)) {
    return snapshot;
  }
  return {
    ...snapshot,
    title: "Wait",
  };
}

function isGrokFetch(snapshot: ACPToolSnapshot, input: Record<string, unknown> | null): boolean {
  if (snapshot.kind === "fetch") return true;
  const title = snapshot.title.trim().toLowerCase();
  if (title === "open_page" || title.startsWith("open page") || title.startsWith("open_page")) {
    return true;
  }
  const action = asRecord(input?.action);
  if (!action) return false;
  const actionType = firstString(action.type);
  if (actionType === "open_page" || actionType === "fetch" || actionType === "browse") return true;
  // Nested target URL without a concrete search action — open_page shape.
  return (
    firstString(action.url, action.uri, action.href) != null &&
    firstString(action.query, action.pattern) == null
  );
}

function asFetchDefault(
  defaultDetail: ToolCallDetail,
): Extract<ToolCallDetail, { type: "fetch" }> | null {
  return defaultDetail.type === "fetch" ? defaultDetail : null;
}

function resolveFetchUrl(
  snapshot: ACPToolSnapshot,
  input: Record<string, unknown> | null,
  action: Record<string, unknown> | null,
  fromDefault: Extract<ToolCallDetail, { type: "fetch" }> | null,
): string {
  return (
    firstString(
      input?.url,
      input?.uri,
      input?.href,
      action?.url,
      action?.uri,
      action?.href,
      fromDefault?.url,
    ) ?? snapshot.title
  );
}

function resolveFetchResult(
  snapshot: ACPToolSnapshot,
  rawOutput: Record<string, unknown> | null,
  fromDefault: Extract<ToolCallDetail, { type: "fetch" }> | null,
): string | null {
  return (
    extractTextFromContent(snapshot.content) ??
    extractTextFromRawOutput(snapshot.rawOutput) ??
    firstString(rawOutput?.result, rawOutput?.text, rawOutput?.content) ??
    fromDefault?.result ??
    null
  );
}

function resolveFetchCode(
  rawOutput: Record<string, unknown> | null,
  fromDefault: Extract<ToolCallDetail, { type: "fetch" }> | null,
): number | undefined {
  const codeValue = rawOutput?.status ?? rawOutput?.code ?? fromDefault?.code;
  return typeof codeValue === "number" ? codeValue : undefined;
}

function mapFetchDetail(
  snapshot: ACPToolSnapshot,
  input: Record<string, unknown> | null,
  defaultDetail: ToolCallDetail,
): ToolCallDetail {
  const action = asRecord(input?.action);
  const rawOutput = asRecord(snapshot.rawOutput);
  const fromDefault = asFetchDefault(defaultDetail);
  const url = resolveFetchUrl(snapshot, input, action, fromDefault);
  const prompt = firstString(input?.prompt, action?.prompt, fromDefault?.prompt);
  const result = resolveFetchResult(snapshot, rawOutput, fromDefault);
  const code = resolveFetchCode(rawOutput, fromDefault);
  const detail: Extract<ToolCallDetail, { type: "fetch" }> = { type: "fetch", url };
  if (prompt) detail.prompt = prompt;
  if (result) detail.result = result;
  if (code !== undefined) detail.code = code;
  return detail;
}

/**
 * Map Grok-specific ACP tool snapshots onto Paseo tool details.
 * Returns `defaultDetail` unchanged for tools we don't special-case.
 */
export function mapGrokAcpToolDetail(
  snapshot: ACPToolSnapshot,
  defaultDetail: ToolCallDetail,
): ToolCallDetail {
  const input = asRecord(snapshot.rawInput);
  const rawOutput = asRecord(snapshot.rawOutput);

  if (isGrokTaskSpawn(snapshot, input)) {
    return mapTaskSpawnDetail(snapshot, input);
  }
  if (isGrokTaskOutput(snapshot, input, rawOutput)) {
    return mapTaskOutputDetail(snapshot, input);
  }
  // Grok nests web_search under action.query; generic ACP only reads top-level
  // query/pattern and falls back to the placeholder title "Web search:".
  if (isGrokWebSearch(snapshot, input)) {
    return mapWebSearchDetail(snapshot, input, defaultDetail);
  }
  // Grok open_page nests the target under action.url (also uri/href, action.prompt).
  if (isGrokFetch(snapshot, input)) {
    return mapFetchDetail(snapshot, input, defaultDetail);
  }
  return defaultDetail;
}
