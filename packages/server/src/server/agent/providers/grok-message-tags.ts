import type { ACPToolSnapshot } from "./acp-agent.js";

// Grok injects model-facing XML envelopes into the user/tool channels. ACP
// surfaces those as ordinary timeline items unless we normalize them here.

const SYSTEM_REMINDER_BLOCK = /<system-reminder>[\s\S]*?<\/system-reminder>/gi;
const USER_INFO_BLOCK = /<user_info>[\s\S]*?<\/user_info>/gi;
const GIT_STATUS_BLOCK = /<git_status>[\s\S]*?<\/git_status>/gi;
const INSTRUCTION_BLOCK = /<instruction>[\s\S]*?<\/instruction>/gi;
const USER_QUERY_WRAPPER = /^<user_query>\s*([\s\S]*?)\s*<\/user_query>\s*$/i;
const SPOKEN_INPUT_WRAPPER =
  /^<spoken-input>\s*([\s\S]*?)\s*<\/spoken-input>\s*(?:<instruction>[\s\S]*?<\/instruction>)?\s*$/i;
const SYSTEM_REMINDER_ONLY = /^<system-reminder>[\s\S]*<\/system-reminder>\s*$/i;
const USER_CONTEXT_ONLY =
  /^<user_info>[\s\S]*<\/user_info>(?:\s*<git_status>[\s\S]*<\/git_status>)?\s*$/i;
const WORKSPACE_RESULT_WRAPPER =
  /^<workspace_result\b[^>]*>\s*([\s\S]*?)\s*<\/workspace_result>\s*$/i;

/**
 * Normalize a Grok user-channel string for the Paseo timeline.
 * Returns `null` when the message is purely synthetic context and must be hidden.
 */
export function normalizeGrokUserMessageText(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  if (SYSTEM_REMINDER_ONLY.test(trimmed) || USER_CONTEXT_ONLY.test(trimmed)) {
    return null;
  }

  let result = trimmed
    .replace(SYSTEM_REMINDER_BLOCK, "")
    .replace(USER_INFO_BLOCK, "")
    .replace(GIT_STATUS_BLOCK, "")
    .trim();

  if (!result) return null;

  // Grok nests voice turns as <user_query><spoken-input>…</spoken-input><instruction>…</instruction></user_query>.
  // Unwrap outer then inner so spoken tags are not left on the timeline.
  const userQuery = result.match(USER_QUERY_WRAPPER);
  if (userQuery) {
    result = userQuery[1].trim();
  }

  const spoken = result.match(SPOKEN_INPUT_WRAPPER);
  if (spoken) {
    result = spoken[1].trim();
  }

  result = result.replace(INSTRUCTION_BLOCK, "").trim();
  return result.length > 0 ? result : null;
}

/** Strip Grok `<workspace_result>` wrappers from tool output text. */
export function normalizeGrokToolResultText(text: string): string {
  const match = text.trim().match(WORKSPACE_RESULT_WRAPPER);
  return match ? match[1].trim() : text;
}

/**
 * ACP tool-call snapshot transform: unwrap `<workspace_result>` from text
 * content blocks and common rawOutput string fields.
 */
export function transformGrokToolSnapshot(snapshot: ACPToolSnapshot): ACPToolSnapshot {
  const content = Array.isArray(snapshot.content)
    ? snapshot.content.map((item) => {
        if (item.type !== "content") return item;
        const block = item.content;
        if (block.type !== "text") return item;
        const nextText = normalizeGrokToolResultText(block.text);
        if (nextText === block.text) return item;
        return { ...item, content: { ...block, text: nextText } };
      })
    : snapshot.content;

  let rawOutput = snapshot.rawOutput;
  if (typeof rawOutput === "string") {
    rawOutput = normalizeGrokToolResultText(rawOutput);
  } else if (rawOutput && typeof rawOutput === "object" && !Array.isArray(rawOutput)) {
    const record = { ...(rawOutput as Record<string, unknown>) };
    let changed = false;
    for (const key of ["content", "text", "output", "result"] as const) {
      const value = record[key];
      if (typeof value !== "string") continue;
      const next = normalizeGrokToolResultText(value);
      if (next === value) continue;
      record[key] = next;
      changed = true;
    }
    if (changed) rawOutput = record;
  }

  if (content === snapshot.content && rawOutput === snapshot.rawOutput) {
    return snapshot;
  }
  return { ...snapshot, content, rawOutput };
}
