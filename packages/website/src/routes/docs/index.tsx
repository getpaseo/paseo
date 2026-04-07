import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/meta";

export const Route = createFileRoute("/docs/")({
  head: () => ({
    meta: pageMeta(
      "Getting Started - Paseo Docs",
      "Learn how to set up and use Paseo to manage your coding agents from anywhere.",
    ),
  }),
  component: GettingStarted,
});

function GettingStarted() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-medium font-title mb-4">Getting Started</h1>
        <p className="text-white/60 leading-relaxed">
          Paseo has three main pieces: the daemon is the local server that manages your agents, the
          app is the client you use from mobile, web, or desktop, and the CLI is the terminal
          interface that can also launch the daemon.
        </p>
      </div>

      <section className="space-y-4">
        <h2 className="text-xl font-medium">Prerequisites</h2>
        <p className="text-white/60">
          Paseo manages existing agent CLIs. Install at least one agent and make sure it already
          works with your credentials before you set up Paseo.
        </p>
        <ul className="text-white/60 space-y-2 list-disc list-inside">
          <li>
            <a
              href="https://docs.anthropic.com/en/docs/claude-code"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-white/80"
            >
              Claude Code
            </a>
          </li>
          <li>
            <a
              href="https://github.com/openai/codex"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-white/80"
            >
              Codex
            </a>
          </li>
          <li>
            <a
              href="https://github.com/anomalyco/opencode"
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-white/80"
            >
              OpenCode
            </a>
          </li>
        </ul>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-medium">Desktop App</h2>
        <p className="text-white/60">
          Download the desktop app from{" "}
          <a
            href="https://paseo.sh/download"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-white/80"
          >
            paseo.sh/download
          </a>{" "}
          or the{" "}
          <a
            href="https://github.com/getpaseo/paseo/releases"
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:text-white/80"
          >
            GitHub releases page
          </a>
          . Open it and you're done.
        </p>
        <p className="text-white/60">
          The desktop app bundles and manages its own daemon automatically, so you do not need a
          separate CLI install on that machine unless you want it.
        </p>
        <p className="text-white/60">
          On first launch, you may briefly see a startup screen while the local server starts and
          the app connects to it. After that, connect from your phone by scanning the QR code in
          Settings if you want mobile access.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-medium">CLI / Server</h2>
        <p className="text-white/60">
          Use this path for headless setups, servers, or remote machines where you want the daemon
          running without the desktop app.
        </p>
        <div className="bg-card border border-border rounded-lg p-4 font-mono text-sm">
          <span className="text-muted-foreground select-none">$ </span>
          <span>npm install -g @getpaseo/cli</span>
        </div>
        <div className="bg-card border border-border rounded-lg p-4 font-mono text-sm">
          <span className="text-muted-foreground select-none">$ </span>
          <span>paseo</span>
        </div>
        <p className="text-white/60">
          Paseo prints a QR code in the terminal. Scan it from the mobile app, or enter the daemon
          address manually from another client.
        </p>
        <p className="text-white/60">
          Configuration and local state live under <code>PASEO_HOME</code>.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-medium">Voice Setup</h2>
        <p className="text-white/60">
          Paseo includes first-class voice support with a local-first architecture and configurable
          speech providers.
        </p>
        <p className="text-white/60">
          For architecture, local model behavior, and provider configuration, see the Voice docs
          page.
        </p>
        <a href="/docs/voice" className="underline hover:text-white/80">
          Voice docs
        </a>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-medium">Next</h2>
        <ul className="text-white/60 space-y-2 list-disc list-inside">
          <li>
            <a href="/docs/updates" className="underline hover:text-white/80">
              Updates
            </a>
          </li>
          <li>
            <a href="/docs/voice" className="underline hover:text-white/80">
              Voice
            </a>
          </li>
          <li>
            <a href="/docs/configuration" className="underline hover:text-white/80">
              Configuration
            </a>
          </li>
          <li>
            <a href="/docs/security" className="underline hover:text-white/80">
              Security
            </a>
          </li>
        </ul>
      </section>
    </div>
  );
}
