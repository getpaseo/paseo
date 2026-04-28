import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/meta";

export const Route = createFileRoute("/docs/cli")({
  head: () => ({
    meta: pageMeta(
      "CLI - Paseo Docs",
      "Paseo CLI reference: manage agents, daemons, permissions, and worktrees from your terminal.",
    ),
  }),
  component: CLI,
});

function Code({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-card border border-border rounded-lg p-4 font-mono text-sm overflow-x-auto">
      {children}
    </div>
  );
}

function CLI() {
  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-3xl font-medium font-title mb-4">CLI</h1>
        <p className="text-white/60 leading-relaxed">
          The Paseo CLI lets you manage agents from your terminal. It&apos;s the same interface
          exposed by the daemon&apos;s API, so anything you can do in the app you can do from the
          command line.
        </p>
      </div>

      {/* Agent orchestration callout */}
      <section className="space-y-4">
        <div className="bg-primary/10 border border-primary/30 rounded-lg p-4 text-white/80">
          <strong>Agent orchestration:</strong> You can tell coding agents to use the Paseo CLI to
          spawn and manage other agents. This enables multi-agent workflows where one agent
          delegates subtasks to others and waits for results.
        </div>
      </section>

      {/* Quick reference */}
      <section className="space-y-4">
        <h2 className="text-xl font-medium">Quick reference</h2>
        <Code>
          <pre className="text-white/80">{`paseo run "fix the tests"           # Start an agent
paseo ls                             # List running agents
paseo attach <id>                    # Stream agent output
paseo send <id> "also fix linting"  # Send follow-up task
paseo logs <id>                      # View agent timeline
paseo stop <id>                      # Stop an agent`}</pre>
        </Code>
      </section>

      {/* Running agents */}
      <section className="space-y-4">
        <h2 className="text-xl font-medium">Running agents</h2>
        <p className="text-white/60 leading-relaxed">
          Use <code className="font-mono">paseo run</code> to start a new agent with a task:
        </p>
        <Code>
          <pre className="text-white/80">{`paseo run "implement user authentication"
paseo run --provider codex "refactor the API layer"
paseo run --detach "run the full test suite"  # background
paseo run --worktree feature-x "implement feature X"
paseo run --output-schema schema.json "extract release notes"
paseo run --output-schema '{"type":"object","properties":{"summary":{"type":"string"}},"required":["summary"]}' "summarize release notes"`}</pre>
        </Code>
        <p className="text-white/60 leading-relaxed">
          The <code className="font-mono">--worktree</code> flag creates the agent in an isolated
          git worktree, useful for parallel feature development.
        </p>
        <p className="text-white/60 leading-relaxed">
          Use <code className="font-mono">--output-schema</code> to return only matching JSON
          output. You can pass a schema file path or an inline JSON schema object. This mode cannot
          be used with <code className="font-mono">--detach</code>.
        </p>
        <p className="text-white/60 leading-relaxed">
          By default, <code className="font-mono">paseo run</code> waits for completion. Use{" "}
          <code className="font-mono">--detach</code> to run in the background.
        </p>
      </section>

      {/* Listing agents */}
      <section className="space-y-4">
        <h2 className="text-xl font-medium">Listing agents</h2>
        <Code>
          <pre className="text-white/80">{`paseo ls                    # Running agents in current directory
paseo ls -a                 # Include completed/stopped agents
paseo ls -g                 # All directories
paseo ls -a -g --json       # Full list as JSON`}</pre>
        </Code>
      </section>

      {/* Streaming output */}
      <section className="space-y-4">
        <h2 className="text-xl font-medium">Streaming output</h2>
        <p className="text-white/60 leading-relaxed">
          Use <code className="font-mono">paseo attach</code> to stream an agent&apos;s output in
          real-time:
        </p>
        <Code>
          <pre className="text-white/80">{`paseo attach abc123   # Attach to agent (Ctrl+C to detach)`}</pre>
        </Code>
        <p className="text-white/60 leading-relaxed">
          Agent IDs can be shortened — <code className="font-mono">abc</code> works if it&apos;s
          unambiguous.
        </p>
      </section>

      {/* Sending messages */}
      <section className="space-y-4">
        <h2 className="text-xl font-medium">Sending messages</h2>
        <p className="text-white/60 leading-relaxed">
          Send follow-up tasks to a running or idle agent:
        </p>
        <Code>
          <pre className="text-white/80">{`paseo send <id> "now run the tests"
paseo send <id> --image screenshot.png "what's wrong here?"
paseo send <id> --no-wait "queue this task"`}</pre>
        </Code>
      </section>

      {/* Viewing logs */}
      <section className="space-y-4">
        <h2 className="text-xl font-medium">Viewing logs</h2>
        <Code>
          <pre className="text-white/80">{`paseo logs <id>                  # Full timeline
paseo logs <id> -f               # Follow (streaming)
paseo logs <id> --tail 10        # Last 10 entries
paseo logs <id> --filter tools   # Only tool calls`}</pre>
        </Code>
      </section>

      {/* Waiting for agents */}
      <section className="space-y-4">
        <h2 className="text-xl font-medium">Waiting for agents</h2>
        <p className="text-white/60 leading-relaxed">
          Block until an agent finishes its current task:
        </p>
        <Code>
          <pre className="text-white/80">{`paseo wait <id>
paseo wait <id> --timeout 60   # 60 second timeout`}</pre>
        </Code>
        <p className="text-white/60 leading-relaxed">
          Useful in scripts or when one agent needs to wait for another.
        </p>
      </section>

      {/* Permissions */}
      <section className="space-y-4">
        <h2 className="text-xl font-medium">Permissions</h2>
        <p className="text-white/60 leading-relaxed">
          Agents may request permission for certain actions. Manage these from the CLI:
        </p>
        <Code>
          <pre className="text-white/80">{`paseo permit ls                # List pending requests
paseo permit allow <id>        # Allow all pending for agent
paseo permit deny <id> --all   # Deny all pending`}</pre>
        </Code>
      </section>

      {/* Agent modes */}
      <section className="space-y-4">
        <h2 className="text-xl font-medium">Agent modes</h2>
        <p className="text-white/60 leading-relaxed">
          Change an agent&apos;s operational mode (provider-specific):
        </p>
        <Code>
          <pre className="text-white/80">{`paseo agent mode <id> --list   # Show available modes
paseo agent mode <id> bypass   # Set bypass mode
paseo agent mode <id> plan     # Set plan mode`}</pre>
        </Code>
      </section>

      {/* Daemon management */}
      <section className="space-y-4">
        <h2 className="text-xl font-medium">Daemon management</h2>
        <Code>
          <pre className="text-white/80">{`paseo daemon start             # Start the daemon
paseo daemon status            # Check status
paseo daemon stop              # Stop the daemon`}</pre>
        </Code>
        <p className="text-white/60 leading-relaxed">
          Use <code className="font-mono">PASEO_HOME</code> to run multiple isolated daemon
          instances.
        </p>
      </section>

      {/* Multi-agent workflows */}
      <section className="space-y-4">
        <h2 className="text-xl font-medium">Multi-agent workflows</h2>
        <p className="text-white/60 leading-relaxed">
          The CLI is designed to be used by agents themselves. You can instruct an agent to spawn
          sub-agents for parallel work:
        </p>
        <Code>
          <pre className="text-white/80">{`# Agent A spawns Agent B and waits for it
paseo run --detach "implement the API" --name api-agent
paseo wait api-agent
paseo logs api-agent --tail 5`}</pre>
        </Code>
        <p className="text-white/60 leading-relaxed">Simple implement + verify loop:</p>
        <Code>
          <pre className="text-white/80">{`# Requires jq
while true; do
  paseo run --provider codex "make the tests pass" >/dev/null

  verdict=$(paseo run --provider claude --output-schema '{"type":"object","properties":{"criteria_met":{"type":"boolean"}},"required":["criteria_met"],"additionalProperties":false}' "ensure tests all pass")
  if echo "$verdict" | jq -e '.criteria_met == true' >/dev/null; then
    echo "criteria met"
    break
  fi
done`}</pre>
        </Code>
        <p className="text-white/60 leading-relaxed">
          This pattern enables hierarchical task decomposition — a lead agent can break down work,
          delegate to specialists, and synthesize results.
        </p>
      </section>

      {/* Output formats */}
      <section className="space-y-4">
        <h2 className="text-xl font-medium">Output formats</h2>
        <p className="text-white/60 leading-relaxed">
          Most commands support multiple output formats for scripting:
        </p>
        <Code>
          <pre className="text-white/80">{`paseo ls --json                # JSON output
paseo ls --format yaml         # YAML output
paseo ls -q                    # IDs only (quiet)`}</pre>
        </Code>
      </section>

      {/* Global options */}
      <section className="space-y-4">
        <h2 className="text-xl font-medium">Global options</h2>
        <ul className="text-white/60 space-y-2 list-disc list-inside">
          <li>
            <code className="font-mono">--host &lt;host:port&gt;</code> — connect to a different
            daemon
          </li>
          <li>
            <code className="font-mono">--json</code> — JSON output
          </li>
          <li>
            <code className="font-mono">-q, --quiet</code> — minimal output
          </li>
          <li>
            <code className="font-mono">--no-color</code> — disable colors
          </li>
        </ul>
      </section>
    </div>
  );
}
