import { createFileRoute } from "@tanstack/react-router";
import { pageMeta } from "~/meta";

export const Route = createFileRoute("/docs/skills")({
  head: () => ({
    meta: pageMeta(
      "Orchestration Skills - Paseo Docs",
      "Paseo orchestration skills: teach coding agents to spawn, coordinate, and manage other agents using slash commands.",
    ),
  }),
  component: Skills,
});

function Code({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-card border border-border rounded-lg p-4 font-mono text-sm overflow-x-auto">
      {children}
    </div>
  );
}

function Skills() {
  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-3xl font-medium font-title mb-4">Orchestration Skills</h1>
        <p className="text-white/60 leading-relaxed">
          Paseo ships orchestration skills that teach coding agents (Claude Code, Codex) how to use
          the Paseo CLI to spawn, coordinate, and manage other agents. Skills are slash commands your
          agent can invoke — they provide the prompts, context, and workflows so agents know how to
          orchestrate without you writing boilerplate. Install them from the desktop app's
          Integrations settings or via the CLI.
        </p>
      </div>

      {/* Installation */}
      <section className="space-y-4">
        <h2 className="text-xl font-medium">Installation</h2>
        <p className="text-white/60 leading-relaxed">Two ways to install:</p>
        <ul className="text-white/60 space-y-2 list-disc list-inside">
          <li>
            <strong>Desktop app:</strong> Settings → Integrations → Install
          </li>
          <li>
            <strong>Manual:</strong> <code className="font-mono">npx skills add getpaseo/paseo</code>{" "}
            — this installs to <code className="font-mono">~/.agents/skills/</code> and sets up
            symlinks for each agent.
          </li>
        </ul>
      </section>

      {/* /paseo */}
      <section className="space-y-4">
        <h2 className="text-xl font-medium">
          <code className="font-mono">/paseo</code> — CLI Reference
        </h2>
        <p className="text-white/60 leading-relaxed">
          The foundational skill. Loaded automatically by other skills. Contains the full Paseo CLI
          command reference so agents know how to run commands.
        </p>
        <p className="text-white/60 leading-relaxed">
          Not typically invoked directly by users — it's a reference that other skills depend on.
        </p>
      </section>

      {/* /paseo-handoff */}
      <section className="space-y-4">
        <h2 className="text-xl font-medium">
          <code className="font-mono">/paseo-handoff</code> — Task Handoff
        </h2>
        <p className="text-white/60 leading-relaxed">
          Hands off your current task to another agent with full context. The receiving agent gets a
          comprehensive prompt with: task description, relevant files, what's been tried, decisions
          made, and acceptance criteria.
        </p>
        <p className="text-white/60 leading-relaxed">
          Default provider is Codex. Can specify Claude (sonnet/opus). Supports{" "}
          <code className="font-mono">--worktree</code> for isolated git branches.
        </p>
        <Code>
          <pre className="text-white/80">{`/paseo-handoff hand off the auth fix to codex in a worktree
/paseo-handoff hand this to claude opus for review`}</pre>
        </Code>
      </section>

      {/* /paseo-loop */}
      <section className="space-y-4">
        <h2 className="text-xl font-medium">
          <code className="font-mono">/paseo-loop</code> — Iterative Loops
        </h2>
        <p className="text-white/60 leading-relaxed">
          Runs an agent in a loop with automatic verification until an exit condition is met. Worker
          runs, verifier checks, repeat until done or max iterations. Supports different providers for
          worker vs verifier (e.g., Codex implements, Claude verifies).
        </p>
        <p className="text-white/60 leading-relaxed">
          Stop conditions: <code className="font-mono">--max-iterations</code>,{" "}
          <code className="font-mono">--max-time</code>, or verification passes.
        </p>
        <Code>
          <pre className="text-white/80">{`/paseo-loop fix the failing tests, verify with npm test, max 5 iterations
/paseo-loop use codex to implement, claude sonnet to verify, loop until tests pass`}</pre>
        </Code>
      </section>

      {/* /paseo-orchestrator */}
      <section className="space-y-4">
        <h2 className="text-xl font-medium">
          <code className="font-mono">/paseo-orchestrator</code> — Team Orchestration
        </h2>
        <p className="text-white/60 leading-relaxed">
          Builds and manages a team of agents coordinating through a shared chat room. You describe
          the work, it sets up roles, launches agents, and coordinates through chat. Uses a heartbeat
          schedule to check progress.
        </p>
        <p className="text-white/60 leading-relaxed">
          Cross-provider: typically Codex for implementation, Claude for review.
        </p>
        <Code>
          <pre className="text-white/80">{`/paseo-orchestrator spin up a team to implement the database migration, codex implements, claude reviews`}</pre>
        </Code>
      </section>

      {/* /paseo-chat */}
      <section className="space-y-4">
        <h2 className="text-xl font-medium">
          <code className="font-mono">/paseo-chat</code> — Chat Rooms
        </h2>
        <p className="text-white/60 leading-relaxed">
          Use persistent chat rooms for asynchronous agent coordination. Create rooms, post messages,
          read history, wait for replies. Supports @mentions for specific agents or @everyone.
        </p>
        <p className="text-white/60 leading-relaxed">
          Typically used by the orchestrator skill, but can be used directly.
        </p>
        <Code>
          <pre className="text-white/80">{`/paseo-chat create a room called "backend-refactor" for coordinating the API changes
/paseo-chat post to backend-refactor: "API endpoints are done, ready for review"`}</pre>
        </Code>
      </section>

      {/* /paseo-committee */}
      <section className="space-y-4">
        <h2 className="text-xl font-medium">
          <code className="font-mono">/paseo-committee</code> — Committee Planning
        </h2>
        <p className="text-white/60 leading-relaxed">
          Forms a committee of two high-reasoning agents (Claude Opus + GPT 5.4) to analyze a problem
          before implementing. Both agents reason in parallel, then plans are merged. Useful when
          stuck, looping, or facing a hard architectural decision.
        </p>
        <p className="text-white/60 leading-relaxed">
          Agents are prevented from editing code — they only produce a plan.
        </p>
        <Code>
          <pre className="text-white/80">{`/paseo-committee why are the websocket connections dropping under load?
/paseo-committee plan the auth system migration`}</pre>
        </Code>
      </section>
    </div>
  );
}
