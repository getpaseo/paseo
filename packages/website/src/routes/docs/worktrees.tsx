import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/docs/worktrees')({
  head: () => ({
    meta: [
      { title: 'Git Worktrees - Paseo Docs' },
      {
        name: 'description',
        content: 'Run agents in isolated git worktrees for parallel feature development.',
      },
    ],
  }),
  component: Worktrees,
})

function Code({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-card border border-border rounded-lg p-4 font-mono text-sm overflow-x-auto">
      {children}
    </div>
  )
}

function Worktrees() {
  return (
    <div className="space-y-10">
      <div>
        <h1 className="text-3xl font-medium font-title mb-4">Git Worktrees</h1>
        <p className="text-white/60 leading-relaxed">
          Git worktrees let you have multiple working directories from the same repository.
          Paseo uses them to run agents in isolated branches without switching contexts.
        </p>
      </div>

      {/* Why worktrees */}
      <section className="space-y-4">
        <h2 className="text-xl font-medium">Why worktrees?</h2>
        <p className="text-white/60 leading-relaxed">
          Without worktrees, running multiple agents on the same repo means they share the
          working directory. One agent's changes interfere with another's. You can't safely
          run parallel tasks.
        </p>
        <p className="text-white/60 leading-relaxed">
          With worktrees, each agent gets its own directory and branch. They can work
          simultaneously without conflict. When an agent finishes, you review the diff,
          merge the branch, and archive the worktree.
        </p>
      </section>

      {/* Directory structure */}
      <section className="space-y-4">
        <h2 className="text-xl font-medium">Directory structure</h2>
        <p className="text-white/60 leading-relaxed">
          Paseo creates worktrees under <code className="font-mono">$PASEO_HOME/worktrees/</code>,
          organized by project:
        </p>
        <Code>
          <pre className="text-white/80">{`~/.paseo/worktrees/
├── my-project/
│   ├── tidy-fox/            # random slug
│   └── bold-owl/            # random slug
└── another-repo/
    └── swift-hare/          # random slug`}</pre>
        </Code>
        <p className="text-white/60 leading-relaxed">
          The project name is derived from your git remote URL or repository directory name.
          Directory names are random slugs — the branch name is separate and chosen when
          you first launch an agent in the worktree.
        </p>
      </section>

      {/* Branches */}
      <section className="space-y-4">
        <h2 className="text-xl font-medium">Branches</h2>
        <p className="text-white/60 leading-relaxed">
          When you create a worktree, Paseo generates a random directory name. The branch name
          is set when you first launch an agent. You can specify a branch name, or Paseo will
          generate one for you.
        </p>
        <p className="text-white/60 leading-relaxed">
          This means the worktree directory and branch are independent. You can rename the
          branch later without affecting the worktree path.
        </p>
      </section>

      {/* Multiple agents */}
      <section className="space-y-4">
        <h2 className="text-xl font-medium">Multiple agents per worktree</h2>
        <p className="text-white/60 leading-relaxed">
          You can launch multiple agents into the same worktree. They share the working
          directory and branch, which is useful when you want agents to collaborate on
          the same feature or when one agent hands off to another.
        </p>
        <p className="text-white/60 leading-relaxed">
          Be mindful of conflicts — agents working on the same files simultaneously can
          step on each other. This works best when agents have distinct responsibilities
          or run sequentially.
        </p>
      </section>

      {/* paseo.json */}
      <section className="space-y-4">
        <h2 className="text-xl font-medium">Setup with paseo.json</h2>
        <p className="text-white/60 leading-relaxed">
          When Paseo creates a worktree, it's a fresh checkout. Dependencies aren't installed,
          config files aren't copied. You can automate setup by creating a{' '}
          <code className="font-mono">paseo.json</code> file in your repository root:
        </p>
        <Code>
          <pre className="text-white/80">{`{
  "worktree": {
    "setup": [
      "npm ci",
      "cp \\"$PASEO_ROOT_PATH/.env\\" \\"$PASEO_WORKTREE_PATH/.env\\""
    ]
  }
}`}</pre>
        </Code>
        <p className="text-white/60 leading-relaxed">
          The <code className="font-mono">setup</code> array contains shell commands that run
          after the worktree is created. Use it to install dependencies, copy local config
          files, or run any other initialization.
        </p>
      </section>

      {/* Environment variables */}
      <section className="space-y-4">
        <h2 className="text-xl font-medium">Environment variables</h2>
        <p className="text-white/60 leading-relaxed">
          Setup commands have access to these environment variables:
        </p>
        <ul className="text-white/60 space-y-2 list-disc list-inside">
          <li>
            <code className="font-mono">$PASEO_ROOT_PATH</code> — your original repository root
          </li>
          <li>
            <code className="font-mono">$PASEO_WORKTREE_PATH</code> — the new worktree directory
          </li>
          <li>
            <code className="font-mono">$PASEO_BRANCH_NAME</code> — the branch name created
          </li>
        </ul>
        <p className="text-white/60 leading-relaxed">
          Use <code className="font-mono">$PASEO_ROOT_PATH</code> to copy files that shouldn't
          be in git (like <code className="font-mono">.env</code>) from your main checkout to
          the worktree.
        </p>
      </section>

      {/* Common patterns */}
      <section className="space-y-4">
        <h2 className="text-xl font-medium">Common patterns</h2>

        <h3 className="text-lg font-medium mt-6">Node.js / npm</h3>
        <Code>
          <pre className="text-white/80">{`{
  "worktree": {
    "setup": ["npm ci"]
  }
}`}</pre>
        </Code>

        <h3 className="text-lg font-medium mt-6">Python / Poetry</h3>
        <Code>
          <pre className="text-white/80">{`{
  "worktree": {
    "setup": ["poetry install"]
  }
}`}</pre>
        </Code>

        <h3 className="text-lg font-medium mt-6">Copy environment files</h3>
        <Code>
          <pre className="text-white/80">{`{
  "worktree": {
    "setup": [
      "npm ci",
      "cp \\"$PASEO_ROOT_PATH/.env\\" \\"$PASEO_WORKTREE_PATH/.env\\"",
      "cp \\"$PASEO_ROOT_PATH/.env.local\\" \\"$PASEO_WORKTREE_PATH/.env.local\\""
    ]
  }
}`}</pre>
        </Code>

        <h3 className="text-lg font-medium mt-6">Run database migrations</h3>
        <Code>
          <pre className="text-white/80">{`{
  "worktree": {
    "setup": [
      "npm ci",
      "cp \\"$PASEO_ROOT_PATH/.env\\" \\"$PASEO_WORKTREE_PATH/.env\\"",
      "npm run db:migrate"
    ]
  }
}`}</pre>
        </Code>
      </section>

      {/* Workflow */}
      <section className="space-y-4">
        <h2 className="text-xl font-medium">Workflow</h2>
        <p className="text-white/60 leading-relaxed">
          The typical workflow is:
        </p>
        <ol className="text-white/60 space-y-2 list-decimal list-inside">
          <li>
            Create a worktree — Paseo creates the directory and runs setup
          </li>
          <li>
            Launch an agent — Paseo creates or assigns a branch
          </li>
          <li>
            Agent works in isolation — changes stay in its worktree
          </li>
          <li>
            Review the diff — compare against the base branch
          </li>
          <li>
            Merge or discard — if approved, merge the branch; otherwise archive
          </li>
          <li>
            Archive the worktree — cleans up the directory and optionally the branch
          </li>
        </ol>
        <p className="text-white/60 leading-relaxed">
          You can run multiple agents in different worktrees simultaneously. Each worktree
          has its own branch and working directory.
        </p>
      </section>

      {/* CLI reference */}
      <section className="space-y-4">
        <h2 className="text-xl font-medium">CLI reference</h2>
        <p className="text-white/60 leading-relaxed">
          Create an agent in a new worktree:
        </p>
        <Code>
          <pre className="text-white/80">{`paseo run --worktree feature-auth --base main "implement auth"`}</pre>
        </Code>
        <p className="text-white/60 leading-relaxed">
          List all worktrees:
        </p>
        <Code>
          <pre className="text-white/80">{`paseo worktree ls`}</pre>
        </Code>
        <p className="text-white/60 leading-relaxed">
          Archive a worktree (stops agents, removes directory):
        </p>
        <Code>
          <pre className="text-white/80">{`paseo worktree archive feature-auth`}</pre>
        </Code>
      </section>

      {/* Metadata */}
      <section className="space-y-4">
        <h2 className="text-xl font-medium">Metadata</h2>
        <p className="text-white/60 leading-relaxed">
          Paseo stores metadata in each worktree's git directory to track the base branch.
          This is used for diff operations and to know what branch to merge into.
        </p>
        <p className="text-white/60 leading-relaxed">
          You don't need to manage this manually — Paseo handles it when creating and
          archiving worktrees.
        </p>
      </section>
    </div>
  )
}
