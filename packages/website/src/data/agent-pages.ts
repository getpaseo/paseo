import type { TFunction } from "i18next";

// Source of truth for per-agent marketing landing pages. Each page's copy lives in the
// `agentPages.<slug>` translation resources. To add an agent, append it here, add its copy to every
// resource file, and create a 4-line route file at `src/routes/{-$locale}/<slug>.tsx`.

export interface AgentPageIdentity {
  slug: string;
  name: string;
}

export interface AgentPage extends AgentPageIdentity {
  title: string;
  subtitle: string;
  metaTitle: string;
  metaDescription: string;
}

export const AGENT_PAGES = [
  { slug: "claude-code", name: "Claude Code" },
  { slug: "codex", name: "Codex" },
  { slug: "opencode", name: "OpenCode" },
  { slug: "pi", name: "Pi Agent" },
  { slug: "omp", name: "OMP (Oh My Pi)" },
  { slug: "cursor", name: "Cursor" },
  { slug: "muse-code", name: "Muse Code" },
  { slug: "antigravity", name: "Antigravity" },
  { slug: "copilot", name: "GitHub Copilot" },
  { slug: "gemini", name: "Gemini CLI" },
  { slug: "hermes", name: "Hermes Agent" },
  { slug: "qwen-code", name: "Qwen Code" },
  { slug: "kimi", name: "Kimi Code CLI" },
  { slug: "amp", name: "Amp" },
  { slug: "auggie", name: "Auggie CLI" },
  { slug: "cline", name: "Cline" },
  { slug: "codebuddy", name: "Codebuddy Code" },
  { slug: "cortex-code", name: "Cortex Code" },
  { slug: "corust", name: "Corust Agent" },
  { slug: "crow", name: "crow-cli" },
  { slug: "deepagents", name: "DeepAgents" },
  { slug: "deepseek-tui", name: "CodeWhale" },
  { slug: "dimcode", name: "DimCode" },
  { slug: "dirac", name: "Dirac" },
  { slug: "factory-droid", name: "Factory Droid" },
  { slug: "fast-agent", name: "fast-agent" },
  { slug: "glm", name: "GLM Agent" },
  { slug: "goose", name: "goose" },
  { slug: "junie", name: "Junie" },
  { slug: "kilo", name: "Kilo Code" },
  { slug: "minion-code", name: "Minion Code" },
  { slug: "mistral-vibe", name: "Mistral Vibe" },
  { slug: "nova", name: "Nova" },
  { slug: "poolside", name: "Poolside" },
  { slug: "qoder", name: "Qoder CLI" },
  { slug: "sigit", name: "siGit Code" },
  { slug: "stakpak", name: "Stakpak" },
  { slug: "vtcode", name: "VT Code" },
  { slug: "agoragentic", name: "Agoragentic" },
  { slug: "autohand", name: "Autohand Code" },
  { slug: "grok", name: "Grok" },
] as const satisfies readonly AgentPageIdentity[];

export type AgentPageSlug = (typeof AGENT_PAGES)[number]["slug"];

/** An agent's landing page copy in the translator's language. */
export function getAgentPage(slug: AgentPageSlug, t: TFunction): AgentPage {
  const page = AGENT_PAGES.find((candidate) => candidate.slug === slug);
  if (!page) throw new Error(`Unknown agent page slug: ${slug}`);
  return {
    ...page,
    title: t(`agentPages.${slug}.title`),
    subtitle: t(`agentPages.${slug}.subtitle`),
    metaTitle: t(`agentPages.${slug}.metaTitle`),
    metaDescription: t(`agentPages.${slug}.metaDescription`),
  };
}
