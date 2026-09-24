import { MAX_EXPLICIT_AGENT_TITLE_CHARS } from "../agent-title-limits.js";

export const MAX_RESPONSE_FOOTER_LENGTH = 4096;
const MARKER = "<paseo-meta";

export const MAX_RECOMMENDED_PROMPTS = 3;
export const RECOMMENDED_PROMPT_ATTRIBUTES = ["prompt1", "prompt2", "prompt3"] as const;

export interface ResponseFooterMetadata {
  message: string;
  title?: string;
  icon?: string;
  /** Recommended prompts in the agent's order; the client offers them as one-click follow-ups. */
  prompts?: string[];
}

interface ParsedFooter {
  text: string;
  metadata: ResponseFooterMetadata;
}

function decodeAttribute(value: string): string | null {
  if (/[<>\r\n]/.test(value)) return null;
  let valid = true;
  const decoded = value.replace(/&([^;\s]*);?/g, (entity) => {
    const entities: Record<string, string> = {
      "&amp;": "&",
      "&quot;": '"',
      "&apos;": "'",
      "&lt;": "<",
      "&gt;": ">",
    };
    const named = entities[entity];
    if (named !== undefined) return named;
    const numeric = /^&#(x[\da-f]+|\d+);$/i.exec(entity);
    if (numeric) {
      const digits = numeric[1];
      const code = digits.toLowerCase().startsWith("x")
        ? Number.parseInt(digits.slice(1), 16)
        : Number(digits);
      if (code >= 32 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) {
        return String.fromCodePoint(code);
      }
    }
    valid = false;
    return entity;
  });
  return valid ? decoded : null;
}

function footerCandidate(text: string): { start: number; suffix: string } | null {
  const end = text.trimEnd().length;
  const start = text.lastIndexOf("\n", end - 1) + 1;
  if (text.length - start > MAX_RESPONSE_FOOTER_LENGTH) return null;
  const line = text.slice(start, end);
  if (!/^ {0,3}</.test(line)) return null;
  let fence: { marker: string; length: number } | null = null;
  for (const preceding of text.slice(0, start).split("\n")) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(preceding);
    if (!match) continue;
    if (!fence) {
      fence = { marker: match[1][0], length: match[1].length };
    } else if (
      match[1][0] === fence.marker &&
      match[1].length >= fence.length &&
      !match[2].trim()
    ) {
      fence = null;
    }
  }
  return fence ? null : { start, suffix: line.trimStart() };
}

function attributes(suffix: string): Map<string, string> | null {
  if (!suffix.startsWith(`${MARKER} `) || !suffix.endsWith("/>")) return null;
  let rest = suffix.slice(MARKER.length, -2);
  const values = new Map<string, string>();
  while (rest.trim()) {
    const match = /^\s+([A-Za-z][\w-]*)\s*=\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)')/.exec(rest);
    if (!match || values.has(match[1])) return null;
    const value = decodeAttribute(match[2] ?? match[3]);
    if (
      value === null ||
      Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    )
      return null;
    values.set(match[1], value.trim());
    rest = rest.slice(match[0].length);
  }
  return values;
}

export function parseResponseFooter(text: string): ParsedFooter | null {
  const candidate = footerCandidate(text);
  if (!candidate) return null;
  const values = attributes(candidate.suffix);
  const message = values?.get("message");
  if (!values || !message) return null;
  const title = values.get("title");
  const icon = values.get("icon");
  if (title !== undefined && (!title || title.length > MAX_EXPLICIT_AGENT_TITLE_CHARS)) return null;
  if (icon !== undefined && (!icon || icon.length > 32)) return null;
  const prompts = RECOMMENDED_PROMPT_ATTRIBUTES.map((name) => values.get(name) ?? "").filter(
    Boolean,
  );
  return {
    text: text.slice(0, candidate.start).trimEnd(),
    metadata: {
      message,
      ...(title ? { title } : {}),
      ...(icon ? { icon } : {}),
      ...(prompts.length > 0 ? { prompts } : {}),
    },
  };
}

function isPossibleFooter(suffix: string): boolean {
  if (MARKER.startsWith(suffix)) return true;
  if (!suffix.startsWith(`${MARKER} `)) return false;
  let rest = suffix.slice(MARKER.length);
  const seen = new Set<string>();
  while (rest.trim()) {
    if (rest.trim() === "/") return true;
    const complete = /^\s+([A-Za-z][\w-]*)\s*=\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)')/.exec(rest);
    if (!complete) {
      return /^\s+[A-Za-z][\w-]*\s*(?:=\s*(?:"[^"<>\r\n]*|'[^'<>\r\n]*)?)?$/.test(rest);
    }
    if (seen.has(complete[1]) || decodeAttribute(complete[2] ?? complete[3]) === null) return false;
    seen.add(complete[1]);
    rest = rest.slice(complete[0].length);
  }
  return true;
}

/** Display-only: original text remains available for provider history and turn processing. */
export function responseDisplayText(text: string, streaming = false): string {
  const parsed = parseResponseFooter(text);
  if (parsed) return parsed.text;
  if (!streaming) return text;
  const candidate = footerCandidate(text);
  if (!candidate) return text;
  const { suffix, start } = candidate;
  return isPossibleFooter(suffix) ? text.slice(0, start).trimEnd() : text;
}
