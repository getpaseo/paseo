import { ORIGIN_LABEL } from "@getpaseo/protocol/agent-labels";

// Every heartbeat the Paperclip adapter sends names the env file or opens with this sentence;
// what the person types into a Paperclip session carries neither.
const ADAPTER_MARKERS = [
  "You are a Paperclip agent running as a Paseo session",
  "PAPERCLIP_ENV_FILE",
];

export interface PaperclipPromptSummary {
  issueKey: string | null;
  title: string | null;
}

/** The Paperclip task behind an adapter prompt, or null when the message is not one. */
export function summarizePaperclipPrompt(input: {
  message: string;
  agentLabels: Record<string, string> | undefined;
  agentTitle: string | null | undefined;
}): PaperclipPromptSummary | null {
  if (!input.agentLabels?.[ORIGIN_LABEL]?.startsWith("paperclip:")) return null;
  if (!ADAPTER_MARKERS.some((marker) => input.message.includes(marker))) return null;
  // Agent titles read "Boss · VIZ-35 Automatischer Modell- und Kontowechsel bei Limits".
  const task = (input.agentTitle ?? "").split(" · ").slice(1).join(" · ").trim();
  const match = /^([A-Z][A-Z0-9]*-\d+)\s+(.*)$/.exec(task);
  if (match) return { issueKey: match[1] ?? null, title: match[2]?.trim() || null };
  const keyInText = /\b([A-Z][A-Z0-9]{1,5}-\d+)\b/.exec(input.message)?.[1] ?? null;
  return { issueKey: keyInText, title: task || null };
}
