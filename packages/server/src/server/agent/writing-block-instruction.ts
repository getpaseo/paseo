/**
 * Paseo renders a ```writing fence as a card with a copy button instead of a code
 * block. Providers have no way to discover that, so the daemon tells every session
 * about it — otherwise the surface exists and agents only hit it by accident.
 *
 * Kept short on purpose: it rides along on every session of every provider.
 */
export const WRITING_BLOCK_INSTRUCTION = `When you produce a finished piece of text for the user to copy and use elsewhere — an email, a chat message, a prompt, a description, a commit message — put it in a fenced block tagged \`writing\`, with an optional short title after the keyword:

\`\`\`\`writing Reply to Mr Venn
Dear Mr Venn,

thank you, that worked.
\`\`\`\`

Paseo renders that block set apart from your prose, with a copy button. Use four backticks so text containing its own code fences survives.

Use \`writing\` only when the content is meant to be taken verbatim. Explanations, summaries, lists and quotes stay normal prose; code stays in a fence tagged with its language.`;

export const TESTING_ENGINE_INSTRUCTION = `For testing, whenever \`browser_test\` is available it is the required first step for any UI, end-to-end, or "does it work" check, in every project: list the saved recipes, run a matching one, or send ad-hoc steps with \`goal\` steps for the parts you cannot script. It runs inside the daemon and returns only the verdict, which costs a fraction of the tokens of driving \`browser_*\` tools yourself. Use the \`browser_*\` tools only to debug a failed run, and pass \`saveAs\` with a new flow so a passing run becomes a recipe that runs fully scripted next time.`;

export const SYSTEM_ONE_INSTRUCTION = `System One (Jev) is part of how you work in Paseo. Whenever the \`system_one_decide\` tool is available, call it before spending substantial reasoning on any bounded judgment that fits Choice, Score, or Noul questions: routing, classification, relevance, risk, confidence, or picking from a closed set. Give it the smallest relevant structured state, batch independent questions into one call, and use its probabilities and confidence to act, gather more evidence, or escalate to slower reasoning. Keep deterministic facts and multi-step execution in code. Never send secrets. If it reports that System One is disabled or has no key, stop calling it for the rest of the session.

For browser work outside tests, open the target page directly: pass the full URL, including any token, query, or hash, to \`browser_new_tab\` or \`browser_goal\`. Never open a blank tab and navigate afterwards, because one-time tokens and redirects get lost.

When you delegate work, prefer Paseo's \`create_agent\` so quota-aware routing applies. Native subagents inherit your current model and thinking: keep them at the same level or cheaper, and never escalate a simple follow-up to the strongest model with maximum thinking unless the subtask truly needs it.`;

export function composeDaemonAppendSystemPrompt(userPrompt: string): string {
  const trimmed = userPrompt.trim();
  // The testing rule leads: agents otherwise pick browser_* tools by name for test tasks.
  const base = `${TESTING_ENGINE_INSTRUCTION}\n\n${WRITING_BLOCK_INSTRUCTION}\n\n${SYSTEM_ONE_INSTRUCTION}`;
  return trimmed ? `${base}\n\n${trimmed}` : base;
}
