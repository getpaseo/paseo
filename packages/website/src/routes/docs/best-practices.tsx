import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/docs/best-practices')({
  head: () => ({
    meta: [
      { title: 'Best Practices - Paseo Docs' },
      {
        name: 'description',
        content: 'Tips for getting the most out of Paseo and mobile-first agent workflows.',
      },
    ],
  }),
  component: BestPractices,
})

function BestPractices() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-medium font-serif mb-4">Best Practices</h1>
        <p className="text-white/60 leading-relaxed">
          What I've learned from using Paseo daily. Not rules, just patterns
          that have worked for me.
        </p>
      </div>

      <section className="space-y-4">
        <h2 className="text-xl font-medium">Agents replace typing, not thinking</h2>
        <p className="text-white/60 leading-relaxed">
          Your role has changed. You're no longer the one writing code line by
          line. You're the one making decisions: what to build, how it should
          work, what the architecture looks like. The agent executes, but you
          direct.
        </p>
        <p className="text-white/60 leading-relaxed">
          You can't just say "implement feature X" and walk away. You still
          have to do the hard part: deciding what to build, how it fits into
          the system, what trade-offs to make. Thinking is not optional. At
          least for now, agents replace the typing, not the thinking.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-medium">Verification loops</h2>
        <p className="text-white/60 leading-relaxed">
          The agent needs a way to verify its work. TDD is one implementation of
          this pattern: get the agent to write a failing test, verify it fails
          for the right reasons, then tell it to make the test pass. The agent
          can loop on its own because it knows what "done" means.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-medium">Invest in tooling</h2>
        <p className="text-white/60 leading-relaxed">
          It's not just test runners. For web apps, something like Playwright
          MCP lets the agent take screenshots and verify UI changes. For a SaaS
          app I built a CLI that wraps all the business logic so the agent could
          launch jobs, check statuses, and scrape data without going through the
          UI.
        </p>
        <p className="text-white/60 leading-relaxed">
          Code is cheap with coding agents. I would have never written that CLI
          before because it felt like wasted effort. Now I bootstrap tooling
          first. It pays off exponentially.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-medium">Agents are cheap</h2>
        <p className="text-white/60 leading-relaxed">
          Don't be shy about running multiple agents. Paseo lets you launch
          agents in isolated worktrees. Kick one off with voice while walking,
          then kick off another. They work independently. You get a notification
          when they're done.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-medium">Use voice extensively</h2>
        <p className="text-white/60 leading-relaxed">
          It's much more natural to use voice to communicate ideas and pull them
          out of your brain. The agent will parse and organize your thoughts
          better than if you try to write the perfect prompt. You don't need to
          organize anything. Just talk.
        </p>
        <p className="text-white/60 leading-relaxed">
          Current speech-to-text models are really good. They catch accents,
          acronyms, technical terms. And even when they don't, the LLM will
          infer what you meant.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-medium">Understand the type of work</h2>
        <p className="text-white/60 leading-relaxed">
          Sometimes you need to plan: design a spec, verify it, get the agent to
          follow through. Maybe it takes a couple of agents to work through it.
          Other times it's conversational: kick off a single agent and start
          talking, asking questions. Match your approach to the task.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-medium">Iterate and refactor often</h2>
        <p className="text-white/60 leading-relaxed">
          Don't expect perfect. Expect working. Make it work, make it correct,
          make it beautiful. Each iteration gets you closer. With tests,
          refactoring is cheap.
        </p>
        <p className="text-white/60 leading-relaxed">
          I don't let myself add too many features before stopping to refactor.
          Sometimes I kick off an agent and have it trace code paths, explain
          dependencies, show me how modules connect. I make mental notes during
          code review and circle back.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-medium">Use agents to check agents</h2>
        <p className="text-white/60 leading-relaxed">
          If an agent implements something and you ask it to review its own
          work, it will never find issues. Launch a separate agent with a fresh
          context to review the first agent's code. It will catch things the
          first agent missed or glossed over. An agent might say it's done when
          it's not. Another agent can detect that.
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-xl font-medium">Learn your agents' quirks</h2>
        <p className="text-white/60 leading-relaxed">
          People argue about which model is better. That's the wrong question.
          Each model has strengths and weaknesses. Knowing them is more useful
          than chasing benchmarks. Benchmarks don't mean anything. You need to
          try the models yourself to form an opinion.
        </p>
        <p className="text-white/60 leading-relaxed">
          I use Claude Code as my main driver because it's quick and uses tools
          well. But sometimes it jumps to conclusions and gives up too easily.
          Codex is frustratingly slow but goes deep, doesn't stop, and is
          methodical. It's also stubborn and too serious. These aren't good or
          bad traits, just differences you learn to work around. Use the right
          model for the job.
        </p>
      </section>
    </div>
  )
}
