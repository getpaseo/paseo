// Source of truth for per-agent marketing landing pages.
// To add a new agent, append an entry here and create a 4-line route file at
// `src/routes/<slug>.tsx`. The sitemap (vite.config) reads `AGENT_PAGE_SLUGS`.

export interface AgentPage {
  slug: string;
  name: string;
  title: string;
  subtitle: string;
  metaTitle: string;
  metaDescription: string;
}

export const AGENT_PAGES = [
  {
    slug: "claude-code",
    name: "Claude Code",
    title: "Open source app for Claude Code",
    subtitle:
      "Run Claude Code on your machine, drive it from your phone or desktop. Launch agents, watch them work, review and merge from anywhere.",
    metaTitle: "Claude Code Mobile and Desktop App, Open Source",
    metaDescription:
      "Open source mobile and desktop app for Claude Code. Run agents on your machine, monitor progress, review diffs, and merge from anywhere. Self-hosted, your code stays local.",
  },
  {
    slug: "codex",
    name: "Codex",
    title: "Open source app for Codex",
    subtitle:
      "Run OpenAI's Codex on your machine, drive it from your phone or desktop. Same setup, same machine, no laptop required.",
    metaTitle: "Codex Mobile and Desktop App, Open Source",
    metaDescription:
      "Open source mobile and desktop app for OpenAI Codex. Launch agents on your machine, monitor progress, and ship code from anywhere. Self-hosted.",
  },
  {
    slug: "opencode",
    name: "OpenCode",
    title: "Open source app for OpenCode",
    subtitle:
      "Run OpenCode on your machine, drive it from your phone or desktop. Open source on both ends, your code stays local.",
    metaTitle: "OpenCode Mobile and Desktop App, Open Source",
    metaDescription:
      "Open source mobile and desktop app for OpenCode. Launch agents on your machine, watch them work, ship code from anywhere. Self-hosted.",
  },
  {
    slug: "copilot",
    name: "GitHub Copilot",
    title: "Open source app for GitHub Copilot",
    subtitle:
      "Drive GitHub Copilot from your phone or desktop. Same account, same machine, ship without sitting down at your desk.",
    metaTitle: "GitHub Copilot Mobile and Desktop App, Open Source",
    metaDescription:
      "Open source mobile and desktop app for GitHub Copilot. Launch sessions on your machine, monitor progress, merge from anywhere.",
  },
  {
    slug: "omp",
    name: "OMP (Oh My Pi)",
    title: "Open source app for OMP (Oh My Pi)",
    subtitle:
      "Run OMP (Oh My Pi) on your machine, drive it from your phone or desktop. Self-hosted and open source.",
    metaTitle: "OMP (Oh My Pi) Mobile and Desktop App, Open Source",
    metaDescription:
      "Open source mobile and desktop app for OMP (Oh My Pi). Launch sessions on your machine, monitor progress, merge from anywhere. Self-hosted.",
  },
  {
    slug: "pi",
    name: "Pi Agent",
    title: "Open source app for the Pi coding agent",
    subtitle:
      "Run the Pi coding agent on your machine, drive it from your phone or desktop. Self-hosted and open source.",
    metaTitle: "Pi Agent Mobile and Desktop App, Open Source",
    metaDescription:
      "Open source mobile and desktop app for the Pi coding agent. Launch sessions on your machine, monitor progress, merge from anywhere. Self-hosted.",
  },
  {
    slug: "cursor",
    name: "Cursor",
    title: "Open source app for Cursor",
    subtitle:
      "Send tasks to Cursor on your machine, drive it from your phone or desktop. Review the diff anywhere.",
    metaTitle: "Cursor Mobile and Desktop App, Open Source",
    metaDescription:
      "Open source mobile and desktop app for Cursor. Launch tasks on your machine, monitor output, review diffs, and merge from anywhere. Self-hosted.",
  },
  {
    slug: "gemini",
    name: "Gemini CLI",
    title: "Open source app for Gemini CLI",
    subtitle:
      "Run Google's Gemini CLI on your machine, drive it from your phone or desktop. Real coding work, no laptop required.",
    metaTitle: "Gemini CLI Mobile and Desktop App, Open Source",
    metaDescription:
      "Open source mobile and desktop app for Google's Gemini CLI. Launch agents on your machine, monitor progress, and ship from anywhere. Self-hosted.",
  },
  {
    slug: "hermes",
    name: "Hermes Agent",
    title: "Open source app for the Hermes agent",
    subtitle:
      "Run Nous Research's Hermes Agent on your machine, drive it from your phone or desktop.",
    metaTitle: "Hermes Agent Mobile and Desktop App, Open Source",
    metaDescription:
      "Open source mobile and desktop app for Nous Research's Hermes Agent. Launch sessions on your machine, monitor progress, ship code from anywhere.",
  },
  {
    slug: "qwen-code",
    name: "Qwen Code",
    title: "Open source app for Qwen Code",
    subtitle: "Run Alibaba's Qwen Code on your machine, drive it from your phone or desktop.",
    metaTitle: "Qwen Code Mobile and Desktop App, Open Source",
    metaDescription:
      "Open source mobile and desktop app for Alibaba's Qwen Code. Launch agents on your machine, monitor progress, and merge from anywhere.",
  },
  {
    slug: "kimi",
    name: "Kimi Code CLI",
    title: "Open source app for Kimi Code CLI",
    subtitle:
      "Run Moonshot AI's Kimi Code CLI on your machine, drive it from your phone or desktop.",
    metaTitle: "Kimi Code CLI Mobile and Desktop App, Open Source",
    metaDescription:
      "Open source mobile and desktop app for Moonshot AI's Kimi Code CLI. Launch sessions on your machine, monitor progress, ship from anywhere.",
  },
  {
    slug: "amp",
    name: "Amp",
    title: "Open source app for the Amp coding agent",
    subtitle:
      "Run Sourcegraph's Amp on your machine, drive it from your phone or desktop. Frontier coding, no laptop required.",
    metaTitle: "Amp Agent Mobile and Desktop App, Open Source",
    metaDescription:
      "Open source mobile and desktop app for Amp, Sourcegraph's frontier coding agent. Launch tasks on your machine, monitor progress, ship from anywhere.",
  },
  {
    slug: "auggie",
    name: "Auggie CLI",
    title: "Open source app for Auggie CLI",
    subtitle: "Run Augment Code's Auggie CLI on your machine, drive it from your phone or desktop.",
    metaTitle: "Auggie CLI Mobile and Desktop App, Open Source",
    metaDescription:
      "Open source mobile and desktop app for Augment Code's Auggie CLI. Launch sessions on your machine, monitor progress, ship from anywhere.",
  },
  {
    slug: "cline",
    name: "Cline",
    title: "Open source app for the Cline coding agent",
    subtitle:
      "Run the Cline coding agent on your machine, drive it from your phone or desktop. Watch it work, jump in when needed.",
    metaTitle: "Cline Agent Mobile and Desktop App, Open Source",
    metaDescription:
      "Open source mobile and desktop app for Cline, the autonomous coding agent. Launch tasks, monitor output, review diffs from anywhere.",
  },
  {
    slug: "codebuddy",
    name: "Codebuddy Code",
    title: "Open source app for Codebuddy Code",
    subtitle: "Run Tencent Cloud's Codebuddy on your machine, drive it from your phone or desktop.",
    metaTitle: "Codebuddy Code Mobile and Desktop App, Open Source",
    metaDescription:
      "Open source mobile and desktop app for Tencent Cloud's Codebuddy Code. Launch sessions on your machine, monitor progress, ship from anywhere.",
  },
  {
    slug: "cortex-code",
    name: "Cortex Code",
    title: "Open source app for Cortex Code",
    subtitle:
      "Run Snowflake's Cortex Code on your machine, drive it from your phone or desktop. No laptop required.",
    metaTitle: "Cortex Code Mobile and Desktop App, Open Source",
    metaDescription:
      "Open source mobile and desktop app for Snowflake's Cortex Code. Launch agents on your machine, monitor progress, ship from anywhere.",
  },
  {
    slug: "corust",
    name: "Corust Agent",
    title: "Open source app for the Corust agent",
    subtitle:
      "Build Rust with the Corust agent on your machine, drive it from your phone or desktop.",
    metaTitle: "Corust Agent Mobile and Desktop App, Open Source",
    metaDescription:
      "Open source mobile and desktop app for the Corust Rust-focused coding agent. Launch tasks on your machine, ship from anywhere.",
  },
  {
    slug: "crow",
    name: "crow-cli",
    title: "Open source app for crow-cli",
    subtitle:
      "Run crow-cli, the minimal ACP-native coding agent, on your machine. Drive it from your phone or desktop.",
    metaTitle: "Crow-CLI Mobile and Desktop App, Open Source",
    metaDescription:
      "Open source mobile and desktop app for crow-cli, the minimal ACP-native coding agent. Launch tasks on your machine, monitor from anywhere.",
  },
  {
    slug: "deepagents",
    name: "DeepAgents",
    title: "Open source app for DeepAgents",
    subtitle:
      "Run LangChain's DeepAgents on your machine, drive it from your phone or desktop. Batteries included.",
    metaTitle: "DeepAgents Mobile and Desktop App, Open Source",
    metaDescription:
      "Open source mobile and desktop app for the LangChain DeepAgents coding agent. Launch sessions on your machine, monitor progress, ship from anywhere.",
  },
  {
    slug: "deepseek-tui",
    name: "CodeWhale",
    title: "Open source app for CodeWhale",
    subtitle:
      "Run CodeWhale's DeepSeek V4 terminal coding agent on your machine, drive it from your phone or desktop.",
    metaTitle: "CodeWhale Mobile and Desktop App, Open Source",
    metaDescription:
      "Open source mobile and desktop app for CodeWhale. Launch coding sessions on your machine, monitor progress, ship from anywhere.",
  },
  {
    slug: "dimcode",
    name: "DimCode",
    title: "Open source app for DimCode",
    subtitle:
      "Leading models, one command. Run DimCode on your machine, drive it from your phone or desktop.",
    metaTitle: "DimCode Mobile and Desktop App, Open Source",
    metaDescription:
      "Open source mobile and desktop app for DimCode, the multi-model coding agent. Launch tasks on your machine, ship from anywhere.",
  },
  {
    slug: "dirac",
    name: "Dirac",
    title: "Open source app for the Dirac coding agent",
    subtitle:
      "Run Dirac's hash-anchored parallel edits on your machine, drive it from your phone or desktop.",
    metaTitle: "Dirac Agent Mobile and Desktop App, Open Source",
    metaDescription:
      "Open source mobile and desktop app for the Dirac coding agent. Hash-anchored parallel edits, AST manipulation, ship from anywhere.",
  },
  {
    slug: "factory-droid",
    name: "Factory Droid",
    title: "Open source app for Factory Droid",
    subtitle:
      "Run Factory's Droid coding agent on your machine, drive it from your phone or desktop.",
    metaTitle: "Factory Droid Mobile and Desktop App, Open Source",
    metaDescription:
      "Open source mobile and desktop app for Factory AI's Droid coding agent. Launch sessions on your machine, monitor progress, ship from anywhere.",
  },
  {
    slug: "fast-agent",
    name: "fast-agent",
    title: "Open source app for fast-agent",
    subtitle:
      "Run fast-agent, the multi-provider coding agent, on your machine. Drive it from your phone or desktop.",
    metaTitle: "Fast-Agent Mobile and Desktop App, Open Source",
    metaDescription:
      "Open source mobile and desktop app for fast-agent, the multi-provider coding agent. Launch tasks on your machine, monitor from anywhere.",
  },
  {
    slug: "glm",
    name: "GLM Agent",
    title: "Open source app for the GLM agent",
    subtitle:
      "Run Zhipu AI's GLM coding agent on your machine, drive it from your phone or desktop. Streaming, mid-session model switching.",
    metaTitle: "GLM Agent Mobile and Desktop App, Open Source",
    metaDescription:
      "Open source mobile and desktop app for Zhipu AI's GLM coding agent. Launch sessions on your machine, monitor progress, ship code from anywhere.",
  },
  {
    slug: "goose",
    name: "goose",
    title: "Open source app for the goose coding agent",
    subtitle:
      "Run Block's goose on your machine, drive it from your phone or desktop. Local, extensible, open source.",
    metaTitle: "Goose Agent Mobile and Desktop App, Open Source",
    metaDescription:
      "Open source mobile and desktop app for Block's goose, the local open-source AI agent. Launch tasks on your machine, ship from anywhere.",
  },
  {
    slug: "junie",
    name: "Junie",
    title: "Open source app for the Junie coding agent",
    subtitle:
      "Run JetBrains' Junie on your machine, drive it from your phone or desktop. Real work, no IDE required.",
    metaTitle: "Junie Agent Mobile and Desktop App, Open Source",
    metaDescription:
      "Open source mobile and desktop app for JetBrains' Junie coding agent. Launch sessions on your machine, monitor progress, ship from anywhere.",
  },
  {
    slug: "kilo",
    name: "Kilo Code",
    title: "Open source app for Kilo Code",
    subtitle:
      "Run Kilo Code on your machine, drive it from your phone or desktop. Send tasks, watch them ship.",
    metaTitle: "Kilo Code Mobile and Desktop App, Open Source",
    metaDescription:
      "Open source mobile and desktop app for Kilo Code. Launch tasks on your machine via Kilo CLI, monitor progress, merge from anywhere.",
  },
  {
    slug: "minion-code",
    name: "Minion Code",
    title: "Open source app for Minion Code",
    subtitle:
      "Run Minion Code's framework agent on your machine, drive it from your phone or desktop.",
    metaTitle: "Minion Code Mobile and Desktop App, Open Source",
    metaDescription:
      "Open source mobile and desktop app for Minion Code, the Minion-framework coding agent. Launch sessions on your machine, ship from anywhere.",
  },
  {
    slug: "mistral-vibe",
    name: "Mistral Vibe",
    title: "Open source app for Mistral Vibe",
    subtitle:
      "Run Mistral's open-source Vibe assistant on your machine, drive it from your phone or desktop.",
    metaTitle: "Mistral Vibe Mobile and Desktop App, Open Source",
    metaDescription:
      "Open source mobile and desktop app for Mistral's Vibe coding assistant. Launch sessions on your machine, monitor progress, ship from anywhere.",
  },
  {
    slug: "nova",
    name: "Nova",
    title: "Open source app for the Nova coding agent",
    subtitle: "Run Compass AI's Nova on your machine, drive it from your phone or desktop.",
    metaTitle: "Nova Agent Mobile and Desktop App, Open Source",
    metaDescription:
      "Open source mobile and desktop app for Compass AI's Nova coding agent. Launch sessions on your machine, monitor progress, merge from anywhere.",
  },
  {
    slug: "poolside",
    name: "Poolside",
    title: "Open source app for the Poolside coding agent",
    subtitle:
      "Drive Poolside's coding agent from your phone or desktop. Kick off the work, watch it land.",
    metaTitle: "Poolside Agent Mobile and Desktop App, Open Source",
    metaDescription:
      "Open source mobile and desktop app for Poolside's coding agent. Launch tasks on your machine, monitor progress, ship from anywhere.",
  },
  {
    slug: "qoder",
    name: "Qoder CLI",
    title: "Open source app for Qoder CLI",
    subtitle:
      "Run the Qoder agentic coding assistant on your machine, drive it from your phone or desktop.",
    metaTitle: "Qoder CLI Mobile and Desktop App, Open Source",
    metaDescription:
      "Open source mobile and desktop app for Qoder, the agentic coding assistant. Launch sessions on your machine, ship from anywhere.",
  },
  {
    slug: "sigit",
    name: "siGit Code",
    title: "Open source app for siGit Code",
    subtitle:
      "Run siGit's local-first coding agent on your machine, drive it from your phone or desktop. Optional on-device LLM inference.",
    metaTitle: "SiGit Code Mobile and Desktop App, Open Source",
    metaDescription:
      "Open source mobile and desktop app for siGit Code, the local-first coding agent. Launch sessions on your machine, ship from anywhere.",
  },
  {
    slug: "stakpak",
    name: "Stakpak",
    title: "Open source app for the Stakpak DevOps agent",
    subtitle:
      "Run Stakpak's Rust-based DevOps agent on your machine, drive it from your phone or desktop.",
    metaTitle: "Stakpak DevOps Agent Mobile and Desktop App, Open Source",
    metaDescription:
      "Open source mobile and desktop app for Stakpak, the Rust-based DevOps agent. Launch tasks on your machine, monitor from anywhere.",
  },
  {
    slug: "vtcode",
    name: "VT Code",
    title: "Open source app for VT Code",
    subtitle:
      "Run VT Code's multi-provider coding agent on your machine, drive it from your phone or desktop.",
    metaTitle: "VT Code Mobile and Desktop App, Open Source",
    metaDescription:
      "Open source mobile and desktop app for VT Code, the multi-provider coding agent. Launch sessions on your machine, ship from anywhere.",
  },
  {
    slug: "agoragentic",
    name: "Agoragentic",
    title: "Open source app for Agoragentic",
    subtitle:
      "Run Agoragentic's 174+ AI capabilities on your machine, drive it from your phone or desktop.",
    metaTitle: "Agoragentic Mobile and Desktop App, Open Source",
    metaDescription:
      "Open source mobile and desktop app for Agoragentic, the AI agent marketplace. Launch sessions on your machine, ship from anywhere.",
  },
  {
    slug: "autohand",
    name: "Autohand Code",
    title: "Open source app for Autohand Code",
    subtitle:
      "Run Autohand AI's coding agent on your machine, drive it from your phone or desktop.",
    metaTitle: "Autohand Code Mobile and Desktop App, Open Source",
    metaDescription:
      "Open source mobile and desktop app for Autohand AI's coding agent. Launch sessions on your machine, monitor progress, ship from anywhere.",
  },
  {
    slug: "grok",
    name: "Grok",
    title: "Open source app for Grok",
    subtitle:
      "Run xAI's Grok Build coding agent on your machine, drive it from your phone or desktop.",
    metaTitle: "Grok Mobile and Desktop App, Open Source",
    metaDescription:
      "Open source mobile and desktop app for xAI's Grok Build coding agent. Launch sessions on your machine, monitor progress, and ship from anywhere. Self-hosted.",
  },
] as const satisfies readonly AgentPage[];

export const AGENT_PAGE_SLUGS: readonly string[] = AGENT_PAGES.map((p) => p.slug);

const AGENT_PAGE_MAP_INTERNAL: Record<string, AgentPage> = Object.fromEntries(
  AGENT_PAGES.map((p) => [p.slug, p]),
);

export function getAgentPage(slug: string): AgentPage {
  const page = AGENT_PAGE_MAP_INTERNAL[slug];
  if (!page) throw new Error(`Unknown agent page slug: ${slug}`);
  return page;
}
