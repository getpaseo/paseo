// The mark for any agent page. Only /agents needs every agent's mark, so the
// vendored SVG set lives here instead of in agent-icons, keeping it out of the
// homepage and agent landing page bundles.

import { Bot } from "lucide-react";
import type * as React from "react";
import {
  AntigravityIcon,
  ClaudeCodeIcon,
  CodexIcon,
  CursorIcon,
  MuseCodeIcon,
  OmpIcon,
  OpenCodeIcon,
  PiIcon,
} from "~/components/agent-icons";
const AGENT_PAGE_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  "claude-code": ClaudeCodeIcon,
  codex: CodexIcon,
  opencode: OpenCodeIcon,
  pi: PiIcon,
  omp: OmpIcon,
  cursor: CursorIcon,
  "muse-code": MuseCodeIcon,
  antigravity: AntigravityIcon,
};

// Marks vendored from the app's ACP provider catalog, named by agent page slug.
const VENDORED_AGENT_PAGE_SVGS = import.meta.glob("../assets/agent-icons/*.svg", {
  eager: true,
  query: "?raw",
  import: "default",
}) as Record<string, string>;

const VENDORED_AGENT_PAGE_MARKUP = new Map(
  Object.entries(VENDORED_AGENT_PAGE_SVGS).map(([path, svg]) => [
    path.slice(path.lastIndexOf("/") + 1, -".svg".length),
    { __html: svg },
  ]),
);

/** The mark for an agent page, falling back to a generic bot for agents without one. */
export function AgentPageIcon({ slug, className }: { slug: string; className?: string }) {
  const Icon = AGENT_PAGE_ICONS[slug];
  if (Icon) return <Icon className={className} />;
  const markup = VENDORED_AGENT_PAGE_MARKUP.get(slug);
  if (markup) {
    return (
      <span
        aria-hidden="true"
        className={`inline-flex [&>svg]:h-full [&>svg]:w-full ${className ?? ""}`}
        dangerouslySetInnerHTML={markup}
      />
    );
  }
  return <Bot className={className} strokeWidth={1.5} aria-hidden="true" />;
}
