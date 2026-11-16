import { ClaudeIcon, CodexIcon, OpenCodeIcon, PiIcon } from "./icons";

/** Each agent provider the mockup shows: its name, its mark, and the model it runs. */
export const PROVIDERS = {
  claude: { name: "Claude Code", Icon: ClaudeIcon, model: "Opus 5.5" },
  codex: { name: "Codex", Icon: CodexIcon, model: "GPT-5.6-Sol" },
  opencode: { name: "OpenCode", Icon: OpenCodeIcon, model: "Kimi K3" },
  pi: { name: "Pi", Icon: PiIcon, model: "GLM-5.2" },
};

export type ProviderId = keyof typeof PROVIDERS;
