import { createFileRoute, Link } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import { AgentPageIcon } from "~/components/agent-page-icon";
import { SiteShell } from "~/components/site-shell";
import { AGENT_PAGES } from "~/data/agent-pages";
import { pageMeta } from "~/meta";
import "~/styles.css";

export const Route = createFileRoute("/agents")({
  head: () =>
    pageMeta(
      "Supported agents – Every coding agent Paseo runs",
      "Run Claude Code, Codex, OpenCode, Pi, OMP, Cursor, Muse Code, Antigravity, and dozens more coding agents from your phone. Self-hosted, your code stays on your machine.",
      "/agents",
    ),
  component: AgentsPage,
});

const LINK_CLASS = "underline hover:text-white";

function AgentsPage() {
  return (
    <SiteShell width="default">
      <h1 className="text-3xl font-medium tracking-tight mb-4">Supported agents</h1>
      <p className="text-lg text-white/70 leading-relaxed max-w-2xl">
        Paseo supports many agents natively, it can run any{" "}
        <a href="/docs/custom-providers#acp-providers" className={LINK_CLASS}>
          ACP agent
        </a>{" "}
        and you can implement new providers via{" "}
        <a href="/docs/plugins/providers" className={LINK_CLASS}>
          plugins
        </a>
        .
      </p>
      <a
        href="/docs/supported-providers"
        target="_blank"
        rel="noopener noreferrer"
        className="mt-3 inline-flex items-center gap-1 text-xs text-extra-muted-foreground transition-colors hover:text-muted-foreground"
      >
        Docs
        <ExternalLink className="h-3 w-3" />
      </a>

      <div className="mt-16 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        {AGENT_PAGES.map((agent) => (
          <Link
            key={agent.slug}
            to={`/${agent.slug}`}
            className="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 hover:border-white/20 hover:bg-white/[0.05] transition-colors"
          >
            <AgentPageIcon slug={agent.slug} className="h-5 w-5 shrink-0 text-white/80" />
            <span className="min-w-0 text-sm font-medium leading-snug text-white">
              {agent.name}
            </span>
          </Link>
        ))}
      </div>
    </SiteShell>
  );
}
