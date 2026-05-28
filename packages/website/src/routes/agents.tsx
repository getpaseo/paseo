import { createFileRoute, Link } from "@tanstack/react-router";
import { CursorFieldProvider } from "~/components/butterfly";
import { SiteFooter } from "~/components/site-footer";
import { SiteHeader } from "~/components/site-header";
import { AGENT_PAGES } from "~/data/agent-pages";
import { pageMeta } from "~/meta";
import "~/styles.css";

export const Route = createFileRoute("/agents")({
  head: () =>
    pageMeta(
      "Supported agents – Every coding agent Paseo runs",
      "Run Claude Code, Codex, Copilot, OpenCode, Cursor CLI, Gemini CLI, and dozens more coding agents from your phone. Self-hosted, your code stays on your machine.",
      "/agents",
    ),
  component: AgentsPage,
});

function AgentsPage() {
  return (
    <CursorFieldProvider>
      <div className="bg-background">
        <div className="p-6 md:px-32 md:pt-20 max-w-7xl mx-auto">
          <nav className="mb-16">
            <SiteHeader />
          </nav>
          <header className="space-y-4 max-w-2xl">
            <h1 className="text-3xl md:text-5xl font-medium tracking-tight">
              Every agent Paseo supports
            </h1>
            <p className="text-white/70 text-lg leading-relaxed">
              Paseo runs the native CLI for {AGENT_PAGES.length} coding agents — your skills, your
              config, your MCP servers, all intact. Drive any of them from your phone.
            </p>
          </header>
        </div>

        <main className="px-6 md:px-32 pb-24 max-w-7xl mx-auto">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {AGENT_PAGES.map((agent) => (
              <Link
                key={agent.slug}
                to={`/${agent.slug}`}
                className="block rounded-xl border border-white/10 bg-white/[0.02] p-5 hover:border-white/20 hover:bg-white/[0.04] transition-colors"
              >
                <h2 className="font-medium text-white">{agent.name}</h2>
                <p className="mt-1 text-sm text-white/60 leading-relaxed">{agent.subtitle}</p>
              </Link>
            ))}
          </div>

          <p className="mt-10 text-sm text-white/50">
            Want to add another?{" "}
            <a href="/docs/custom-providers" className="underline hover:text-white/80">
              Configure any ACP-compatible agent
            </a>{" "}
            in <code className="font-mono text-white/60">~/.paseo/config.json</code>.
          </p>
        </main>

        <SiteFooter />
      </div>
    </CursorFieldProvider>
  );
}
