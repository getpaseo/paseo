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
    title: "Ship with Claude Code from your phone",
    subtitle:
      "Launch agents, check on progress, and merge from anywhere. Your Claude Code setup, your machine, your pocket.",
    metaTitle: "Claude Code Mobile App – Ship from your phone | Paseo",
    metaDescription:
      "Run Claude Code from your phone. Launch agents, check on progress, review diffs, and merge — all from your pocket. Self-hosted, your code stays on your machine.",
  },
  {
    slug: "codex",
    name: "Codex",
    title: "Run Codex from anywhere",
    subtitle:
      "Kick off Codex agents on your machine from your phone. Check in on the train, review on the couch, merge from the park.",
    metaTitle: "Codex Mobile App – Run Codex from anywhere | Paseo",
    metaDescription:
      "Run OpenAI Codex from your phone. Kick off agents, monitor progress, and ship code without being at your desk. Self-hosted, your code never leaves your machine.",
  },
  {
    slug: "opencode",
    name: "OpenCode",
    title: "Run OpenCode from your phone",
    subtitle:
      "Launch agents, check on builds, and ship code from anywhere. Same setup, same machine, just not at your desk.",
    metaTitle: "OpenCode Mobile App – Code from anywhere | Paseo",
    metaDescription:
      "Run OpenCode from your phone. Launch agents, watch them work, and ship code from wherever you are. Self-hosted, open source, your code stays local.",
  },
  {
    slug: "copilot",
    name: "GitHub Copilot",
    title: "GitHub Copilot, mobile",
    subtitle:
      "Drive Copilot from your phone. Kick off changes, watch them land, ship without sitting down at your desk.",
    metaTitle: "GitHub Copilot Mobile App – Drive Copilot from anywhere | Paseo",
    metaDescription:
      "Control GitHub Copilot from your phone. Launch sessions, monitor progress, merge from anywhere. Your machine, your account, your pocket.",
  },
  {
    slug: "pi",
    name: "Pi",
    title: "Run Pi from your phone",
    subtitle: "Tiny agent, full control. Launch Pi from anywhere and check in when it matters.",
    metaTitle: "Pi Mobile App – Run pi from anywhere | Paseo",
    metaDescription:
      "Run the pi coding agent from your phone. Launch sessions on your machine, check progress, merge from your pocket. Self-hosted and open source.",
  },
  {
    slug: "cursor",
    name: "Cursor",
    title: "Cursor, in your pocket",
    subtitle: "Send tasks to Cursor on your machine, watch them run, review the diff on the train.",
    metaTitle: "Cursor Mobile App – Drive Cursor from anywhere | Paseo",
    metaDescription:
      "Run Cursor from your phone. Launch tasks, monitor output, review diffs, and merge — all from your pocket. Self-hosted, your code stays local.",
  },
  {
    slug: "gemini",
    name: "Gemini CLI",
    title: "Run Gemini from anywhere",
    subtitle: "Kick off Google's Gemini CLI from your phone. Real coding work, no laptop required.",
    metaTitle: "Gemini CLI Mobile App – Run Gemini from anywhere | Paseo",
    metaDescription:
      "Drive Google's Gemini CLI from your phone. Launch agents, monitor progress, and ship from anywhere. Self-hosted, your code never leaves your machine.",
  },
  {
    slug: "hermes",
    name: "Hermes Agent",
    title: "Hermes Agent, on your phone",
    subtitle:
      "Drive Nous Research's Hermes Agent from anywhere. Your machine does the work, your pocket runs the show.",
    metaTitle: "Hermes Agent Mobile App – Drive Hermes from anywhere | Paseo",
    metaDescription:
      "Run Nous Research's Hermes Agent from your phone. Launch sessions, monitor progress, ship code from your pocket.",
  },
  {
    slug: "qwen-code",
    name: "Qwen Code",
    title: "Qwen Code from anywhere",
    subtitle: "Send Alibaba's Qwen agent to work on your machine while you're not at your desk.",
    metaTitle: "Qwen Code Mobile App – Run Qwen from anywhere | Paseo",
    metaDescription:
      "Drive Alibaba's Qwen Code from your phone. Launch agents on your machine, monitor progress, and merge from anywhere.",
  },
  {
    slug: "kimi",
    name: "Kimi Code CLI",
    title: "Kimi Code from your phone",
    subtitle:
      "Moonshot AI's Kimi Code CLI on your machine, controlled from anywhere. Same setup, no laptop.",
    metaTitle: "Kimi Code Mobile App – Run Kimi Code from anywhere | Paseo",
    metaDescription:
      "Run Moonshot AI's Kimi Code CLI from your phone. Launch sessions, monitor progress, ship from your pocket. Self-hosted and private.",
  },
  {
    slug: "amp",
    name: "Amp",
    title: "Amp, mobile",
    subtitle:
      "Drive the frontier coding agent from your phone. Kick off work, monitor progress, merge from anywhere.",
    metaTitle: "Amp Mobile App – Run Amp from anywhere | Paseo",
    metaDescription:
      "Run Amp, the frontier coding agent, from your phone. Launch tasks on your machine, watch them ship from your pocket.",
  },
  {
    slug: "auggie",
    name: "Auggie CLI",
    title: "Auggie, in your pocket",
    subtitle:
      "Run Augment Code's agent from your phone. Industry-leading context, anywhere you are.",
    metaTitle: "Auggie Mobile App – Drive Augment Code from anywhere | Paseo",
    metaDescription:
      "Run Augment Code's Auggie CLI from your phone. Launch sessions on your machine, monitor progress, ship code from your pocket.",
  },
  {
    slug: "cline",
    name: "Cline",
    title: "Cline from anywhere",
    subtitle:
      "Autonomous coding agent on your machine, controlled from your phone. Watch it work, jump in when needed.",
    metaTitle: "Cline Mobile App – Run Cline from anywhere | Paseo",
    metaDescription:
      "Drive Cline, the autonomous coding agent, from your phone. Launch tasks, monitor output, review diffs from anywhere.",
  },
  {
    slug: "codebuddy",
    name: "Codebuddy Code",
    title: "Codebuddy from your phone",
    subtitle:
      "Run Tencent Cloud's intelligent coding tool from anywhere. Your dev box, your pocket.",
    metaTitle: "Codebuddy Code Mobile App – Run Codebuddy from anywhere | Paseo",
    metaDescription:
      "Drive Tencent Cloud's Codebuddy Code from your phone. Launch sessions on your machine, monitor progress, ship from anywhere.",
  },
  {
    slug: "cortex-code",
    name: "Cortex Code",
    title: "Cortex Code, mobile",
    subtitle:
      "Snowflake's coding agent on your machine, driven from your phone. No laptop required.",
    metaTitle: "Cortex Code Mobile App – Run Cortex Code from anywhere | Paseo",
    metaDescription:
      "Run Snowflake's Cortex Code from your phone. Launch agents, monitor progress, and ship from anywhere.",
  },
  {
    slug: "corust",
    name: "Corust Agent",
    title: "Corust, in your pocket",
    subtitle: "Build Rust with a seasoned partner on your machine, driven from your phone.",
    metaTitle: "Corust Mobile App – Drive Corust agent from anywhere | Paseo",
    metaDescription:
      "Run the Corust Rust-focused coding agent from your phone. Launch tasks on your machine, ship from your pocket.",
  },
  {
    slug: "crow",
    name: "crow-cli",
    title: "crow-cli from your phone",
    subtitle:
      "Minimal native coding agent on your machine, controlled from anywhere. Lean, ACP-native, mobile.",
    metaTitle: "crow-cli Mobile App – Run crow-cli from anywhere | Paseo",
    metaDescription:
      "Drive crow-cli, the minimal ACP-native coding agent, from your phone. Launch tasks on your machine, monitor from anywhere.",
  },
  {
    slug: "deepagents",
    name: "DeepAgents",
    title: "DeepAgents from your phone",
    subtitle:
      "LangChain-powered coding agent on your machine, driven from anywhere. Batteries included.",
    metaTitle: "DeepAgents Mobile App – Run DeepAgents from anywhere | Paseo",
    metaDescription:
      "Run the LangChain DeepAgents coding agent from your phone. Launch sessions, monitor progress, and ship code from anywhere.",
  },
  {
    slug: "deepseek-tui",
    name: "DeepSeek TUI",
    title: "DeepSeek TUI from your phone",
    subtitle:
      "Run the DeepSeek V4 terminal coding agent on your machine, then drive it from anywhere.",
    metaTitle: "DeepSeek TUI Mobile App – Run DeepSeek TUI from anywhere | Paseo",
    metaDescription:
      "Drive DeepSeek TUI from your phone. Launch coding sessions on your machine, monitor progress, and ship from anywhere.",
  },
  {
    slug: "dimcode",
    name: "DimCode",
    title: "DimCode from anywhere",
    subtitle: "Leading models, one command — driven from your phone. Your machine does the work.",
    metaTitle: "DimCode Mobile App – Run DimCode from anywhere | Paseo",
    metaDescription:
      "Drive DimCode, the multi-model coding agent, from your phone. Launch tasks on your machine, ship from your pocket.",
  },
  {
    slug: "dirac",
    name: "Dirac",
    title: "Dirac, mobile",
    subtitle:
      "Hash-anchored parallel edits on your machine, driven from your pocket. Faster, cheaper, fully open source.",
    metaTitle: "Dirac Mobile App – Run Dirac from anywhere | Paseo",
    metaDescription:
      "Run the Dirac coding agent from your phone. Hash-anchored parallel edits, AST manipulation, ship from anywhere.",
  },
  {
    slug: "factory-droid",
    name: "Factory Droid",
    title: "Factory Droid from anywhere",
    subtitle:
      "Drive Factory's coding agent from your phone. Kick it off, check in, ship from your pocket.",
    metaTitle: "Factory Droid Mobile App – Run Droid from anywhere | Paseo",
    metaDescription:
      "Run Factory AI's Droid coding agent from your phone. Launch sessions on your machine, monitor progress, ship from anywhere.",
  },
  {
    slug: "fast-agent",
    name: "fast-agent",
    title: "fast-agent, mobile",
    subtitle:
      "Multi-provider agent on your machine, controlled from anywhere. Send work, get results.",
    metaTitle: "fast-agent Mobile App – Run fast-agent from anywhere | Paseo",
    metaDescription:
      "Drive fast-agent, the multi-provider coding agent, from your phone. Launch tasks on your machine, monitor from your pocket.",
  },
  {
    slug: "glm",
    name: "GLM Agent",
    title: "GLM Agent from your phone",
    subtitle:
      "Zhipu AI's GLM coding agent on your machine, driven from anywhere. Streaming, mid-session model switching, mobile.",
    metaTitle: "GLM Agent Mobile App – Run GLM from anywhere | Paseo",
    metaDescription:
      "Run Zhipu AI's GLM coding agent from your phone. Launch sessions, monitor progress, and ship code from anywhere.",
  },
  {
    slug: "goose",
    name: "goose",
    title: "Run goose from your phone",
    subtitle:
      "Block's open-source agent on your laptop, driven from anywhere. Local, extensible, mobile.",
    metaTitle: "goose Mobile App – Run goose from anywhere | Paseo",
    metaDescription:
      "Drive Block's goose, the local open-source AI agent, from your phone. Launch tasks on your machine, ship from your pocket.",
  },
  {
    slug: "junie",
    name: "Junie",
    title: "Junie, on your phone",
    subtitle:
      "JetBrains' coding agent on your dev box, controlled from your pocket. Real work, no IDE required.",
    metaTitle: "Junie Mobile App – Run Junie from anywhere | Paseo",
    metaDescription:
      "Drive JetBrains' Junie coding agent from your phone. Launch sessions on your machine, monitor progress, ship from anywhere.",
  },
  {
    slug: "kilo",
    name: "Kilo Code",
    title: "Kilo Code from anywhere",
    subtitle: "Kilo Code on your machine, driven from your phone. Send tasks, watch them ship.",
    metaTitle: "Kilo Code Mobile App – Run Kilo Code from anywhere | Paseo",
    metaDescription:
      "Run Kilo Code, the open-source coding agent, from your phone. Launch tasks on your machine via Kilo CLI, monitor progress, merge from anywhere.",
  },
  {
    slug: "minion-code",
    name: "Minion Code",
    title: "Minion Code, mobile",
    subtitle:
      "Minion-framework agent on your machine, controlled from your phone. Rich tooling, full freedom.",
    metaTitle: "Minion Code Mobile App – Run Minion Code from anywhere | Paseo",
    metaDescription:
      "Drive Minion Code, the Minion-framework coding agent, from your phone. Launch sessions on your machine, ship from your pocket.",
  },
  {
    slug: "mistral-vibe",
    name: "Mistral Vibe",
    title: "Mistral Vibe from your phone",
    subtitle:
      "Mistral's open-source coding assistant, driven from anywhere. Your machine, your pocket.",
    metaTitle: "Mistral Vibe Mobile App – Run Mistral Vibe from anywhere | Paseo",
    metaDescription:
      "Run Mistral's open-source Vibe coding assistant from your phone. Launch sessions on your machine, monitor progress, ship from anywhere.",
  },
  {
    slug: "nova",
    name: "Nova",
    title: "Nova, in your pocket",
    subtitle:
      "Compass AI's software engineer on your machine, controlled from your phone. Send work, ship code.",
    metaTitle: "Nova Mobile App – Run Nova from anywhere | Paseo",
    metaDescription:
      "Drive Compass AI's Nova coding agent from your phone. Launch sessions on your machine, monitor progress, merge from your pocket.",
  },
  {
    slug: "poolside",
    name: "Poolside",
    title: "Poolside, mobile",
    subtitle:
      "Drive Poolside's coding agent from anywhere. Kick off the work, watch it land, merge on the move.",
    metaTitle: "Poolside Mobile App – Run Poolside from anywhere | Paseo",
    metaDescription:
      "Run Poolside's coding agent from your phone. Launch tasks on your machine, monitor progress, ship from anywhere.",
  },
  {
    slug: "qoder",
    name: "Qoder CLI",
    title: "Qoder from your phone",
    subtitle:
      "Agentic coding assistant on your machine, controlled from anywhere. No laptop required.",
    metaTitle: "Qoder Mobile App – Run Qoder from anywhere | Paseo",
    metaDescription:
      "Drive Qoder, the agentic coding assistant, from your phone. Launch sessions on your machine, ship from your pocket.",
  },
  {
    slug: "sigit",
    name: "siGit Code",
    title: "siGit Code, mobile",
    subtitle:
      "Local-first coding agent on your machine, driven from your phone. Optionally on-device LLM inference.",
    metaTitle: "siGit Code Mobile App – Run siGit from anywhere | Paseo",
    metaDescription:
      "Run siGit Code, the local-first coding agent, from your phone. Launch sessions on your machine, ship from anywhere.",
  },
  {
    slug: "stakpak",
    name: "Stakpak",
    title: "Stakpak DevOps from anywhere",
    subtitle:
      "Open-source DevOps agent on your machine, controlled from your phone. Rust speed, enterprise security.",
    metaTitle: "Stakpak Mobile App – Run Stakpak from anywhere | Paseo",
    metaDescription:
      "Drive Stakpak, the Rust-based DevOps agent, from your phone. Launch tasks on your machine, monitor from your pocket.",
  },
  {
    slug: "vtcode",
    name: "VT Code",
    title: "VT Code, mobile",
    subtitle:
      "Multi-provider coding agent on your machine. Send tasks from anywhere, ship from your pocket.",
    metaTitle: "VT Code Mobile App – Run VT Code from anywhere | Paseo",
    metaDescription:
      "Run VT Code, the open-source multi-provider coding agent, from your phone. Launch sessions, monitor progress, ship from anywhere.",
  },
  {
    slug: "agoragentic",
    name: "Agoragentic",
    title: "Agoragentic from your phone",
    subtitle: "174+ AI capabilities on your machine, driven from anywhere. Browse, invoke, ship.",
    metaTitle: "Agoragentic Mobile App – Run Agoragentic from anywhere | Paseo",
    metaDescription:
      "Drive Agoragentic, the AI agent marketplace, from your phone. Launch sessions on your machine, ship from your pocket.",
  },
  {
    slug: "autohand",
    name: "Autohand Code",
    title: "Autohand Code, mobile",
    subtitle:
      "Autohand's coding agent on your machine, controlled from your phone. Real work, no laptop.",
    metaTitle: "Autohand Code Mobile App – Run Autohand from anywhere | Paseo",
    metaDescription:
      "Run Autohand AI's coding agent from your phone. Launch sessions on your machine, monitor progress, ship from anywhere.",
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
